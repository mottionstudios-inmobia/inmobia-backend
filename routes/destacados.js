import { Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { unlink } from 'fs/promises';
import sharp from 'sharp';
import { db } from '../database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '../../public/uploads');

// Multer: acepta hasta 20MB (sharp comprimirá internamente)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `destacado_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype))
});

// Wrapper que convierte errores de multer en respuestas JSON
function uploadSingle(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, err => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'La imagen supera el límite de 20 MB.'
          : `Error al subir imagen: ${err.message}`;
        return res.status(400).json({ error: msg });
      }
      next();
    });
  };
}

// Optimiza la imagen con sharp: convierte a WebP, max 1400px ancho, calidad 82
// Reemplaza el archivo original y devuelve la nueva ruta
async function optimizarImagen(file) {
  const inputPath  = file.path;
  const outputName = `destacado_${Date.now()}.webp`;
  const outputPath = path.join(uploadsDir, outputName);

  await sharp(inputPath)
    .rotate()                          // corregir orientación EXIF
    .resize({ width: 1400, height: 1867, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(outputPath);

  // Eliminar el archivo original
  await unlink(inputPath).catch(() => {});

  return `/uploads/${outputName}`;
}

function auth(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try { return jwt.verify(h.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024'); }
  catch { return null; }
}

// GET /api/destacados — propiedades activas para el slideshow (público)
router.get('/', (req, res) => {
  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`DELETE FROM destacados_hero WHERE expira_en <= ?`).run(ahora);

  const activos = db.prepare(`
    SELECT d.id, d.propiedad_id, d.imagen_url, d.mostrado,
           p.titulo, p.nombre_proyecto, p.tipo, p.operacion,
           p.metros, p.zona, p.precio, p.moneda
    FROM destacados_hero d
    JOIN propiedades p ON p.id = d.propiedad_id
    WHERE d.expira_en > ?
    ORDER BY d.mostrado ASC, RANDOM()
  `).all(ahora);

  if (activos.length && activos.every(d => d.mostrado > 0)) {
    db.prepare(`UPDATE destacados_hero SET mostrado = 0`).run();
    activos.forEach(d => d.mostrado = 0);
    activos.sort(() => Math.random() - 0.5);
  }

  res.json({ destacados: activos });
});

// POST /api/destacados/marcar-mostrado/:id
router.post('/marcar-mostrado/:id', (req, res) => {
  db.prepare(`UPDATE destacados_hero SET mostrado = mostrado + 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/destacados/estado
router.get('/estado', (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: 'Token requerido' });

  const asesor = db.prepare(`SELECT plan FROM usuarios WHERE id = ?`).get(user.id);
  if (!asesor) return res.status(404).json({ error: 'Asesor no encontrado' });

  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const ultimo = db.prepare(`
    SELECT propiedad_id, expira_en, imagen_url FROM destacados_hero
    WHERE asesor_id = ? AND expira_en > ?
    ORDER BY activado_en DESC LIMIT 1
  `).get(user.id, ahora);

  res.json({
    plan: asesor.plan,
    puede_destacar: asesor.plan === 'premium' && !ultimo,
    expira_en: ultimo?.expira_en || null,
    propiedad_id: ultimo?.propiedad_id || null,
    imagen_url: ultimo?.imagen_url || null
  });
});

// POST /api/destacados/activar
router.post('/activar', uploadSingle('imagen'), async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: 'Token requerido' });

  const asesor = db.prepare(`SELECT plan FROM usuarios WHERE id = ?`).get(user.id);
  if (!asesor) return res.status(404).json({ error: 'Asesor no encontrado' });
  if (asesor.plan !== 'premium') return res.status(403).json({ error: 'Solo disponible para plan Premium' });

  const { propiedad_id } = req.body;
  if (!propiedad_id) return res.status(400).json({ error: 'propiedad_id requerido' });

  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const activo = db.prepare(`
    SELECT id FROM destacados_hero WHERE asesor_id = ? AND expira_en > ?
  `).get(user.id, ahora);
  if (activo) return res.status(429).json({ error: 'Ya tienes una propiedad destacada activa. Podrás destacar otra cuando expire.' });

  const prop = db.prepare(`SELECT id, publicado_inmobia FROM propiedades WHERE id = ? AND usuario_id = ?`).get(propiedad_id, user.id);
  if (!prop) return res.status(403).json({ error: 'Propiedad no encontrada o no te pertenece' });
  if (!prop.publicado_inmobia) return res.status(400).json({ error: 'La propiedad debe estar compartida con InmobIA para poder destacarla.' });

  if (!req.file) return res.status(400).json({ error: 'Imagen requerida' });

  try {
    const imagenUrl = await optimizarImagen(req.file);
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(`
      INSERT INTO destacados_hero (propiedad_id, asesor_id, imagen_url, expira_en)
      VALUES (?, ?, ?, ?)
    `).run(propiedad_id, user.id, imagenUrl, expira);

    res.json({ ok: true, expira_en: expira });
  } catch (err) {
    console.error('Error optimizando imagen:', err);
    res.status(500).json({ error: 'Error al procesar la imagen.' });
  }
});

// PATCH /api/destacados/imagen
router.patch('/imagen', uploadSingle('imagen'), async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: 'Token requerido' });

  if (!req.file) return res.status(400).json({ error: 'Imagen requerida' });

  const ahora = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const activo = db.prepare(`
    SELECT id FROM destacados_hero WHERE asesor_id = ? AND expira_en > ?
    ORDER BY activado_en DESC LIMIT 1
  `).get(user.id, ahora);

  if (!activo) return res.status(404).json({ error: 'No tienes una propiedad destacada activa.' });

  try {
    const imagenUrl = await optimizarImagen(req.file);
    db.prepare(`UPDATE destacados_hero SET imagen_url = ? WHERE id = ?`).run(imagenUrl, activo.id);
    res.json({ ok: true, imagen_url: imagenUrl });
  } catch (err) {
    console.error('Error optimizando imagen:', err);
    res.status(500).json({ error: 'Error al procesar la imagen.' });
  }
});

export default router;
