import { Router } from 'express';
import multer from 'multer';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { enviarEmail, htmlCorreoPrincipal, htmlCorreoSuscriptor } from '../email.js';
import { readFileSync } from 'fs';
import 'dotenv/config';

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

function requireAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  next();
}

// Multer en memoria para correo principal
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Multer en disco para fotos de mascota (genera URLs públicas)
const mascotaDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads/mascotas')
  : path.join(__dirname, '../../public/uploads/mascotas');
mkdirSync(mascotaDir, { recursive: true });
const uploadMascota = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, mascotaDir),
    filename: (req, file, cb) => cb(null, `mascota_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── POST /api/email/formulario  (pública — recibe datos del formulario)
router.post('/formulario', async (req, res) => {
  const { nombre, telefono, email, propiedad, proyecto, zona, dias, horario, dia_hora, comentario, codigo, url_propiedad } = req.body;

  const datos = { nombre, telefono, email, propiedad, proyecto, zona, dias, horario, dia_hora, comentario, codigo, url_propiedad };

  try {
    const emailPrincipal = db.prepare("SELECT valor FROM config_email WHERE clave = 'email_principal'").get()?.valor
      || process.env.EMAIL_PRINCIPAL;

    await enviarEmail({ to: emailPrincipal, subject: `Nueva solicitud de visita — ${propiedad || 'Propiedad'}`, html: htmlCorreoPrincipal(datos) });

    const suscriptores = db.prepare('SELECT email FROM suscriptores_email WHERE activo = 1').all();
    if (suscriptores.length) {
      const camposRaw = db.prepare("SELECT valor FROM config_email WHERE clave = 'campos_suscriptores'").get()?.valor;
      const camposPermitidos = camposRaw ? JSON.parse(camposRaw) : [];
      const mensajePersonalizado = db.prepare("SELECT valor FROM config_email WHERE clave = 'mensaje_personalizado'").get()?.valor || '';
      const htmlSusc = htmlCorreoSuscriptor(datos, camposPermitidos, mensajePersonalizado);
      for (const { email: dest } of suscriptores) {
        await enviarEmail({ to: dest, subject: `Solicitud de visita — ${propiedad || 'Propiedad'}`, html: htmlSusc });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando email:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el correo', detalle: err.message });
  }
});

// ── POST /api/email/busqueda  (pública — búsqueda personalizada)
router.post('/busqueda', uploadMascota.array('fotos', 10), async (req, res) => {
  const { nombre, telefono, email, fecha, operacion, tipo, zona, zona_detalle, presupuesto, metros, habitaciones, banos, parqueos, integrantes, caracteristicas, detalle, mascota, desc_mascota, fotos_mascota } = req.body;

  const etiquetas = {
    nombre: 'Nombre', telefono: 'WhatsApp', email: 'Correo electrónico',
    fecha: 'Fecha prevista de mudanza', operacion: 'Operación',
    tipo: 'Tipo de propiedad', zona: 'Zona preferida',
    zona_detalle: 'Sector / Colonia preferida',
    presupuesto: 'Presupuesto máximo', metros: 'Mínimo de m²',
    habitaciones: 'Habitaciones', banos: 'Baños', parqueos: 'Parqueos',
    integrantes: 'Total integrantes de la familia',
    caracteristicas: 'Características deseadas', detalle: 'Descripción adicional',
    mascota: 'Tiene mascota', desc_mascota: 'Descripción de mascota(s)',
    fotos_mascota: 'Fotografías de mascota',
  };

  const datos = { nombre, telefono, email, fecha, operacion, tipo, zona, zona_detalle, presupuesto, metros, habitaciones, banos, parqueos, integrantes, caracteristicas, detalle, mascota, desc_mascota, fotos_mascota };

  const filas = Object.entries(datos)
    .filter(([, v]) => v)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;white-space:nowrap">${etiquetas[k] || k}</td>
        <td style="padding:8px 12px;color:#444;border-bottom:1px solid #e5e2da">${v}</td>
      </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding:28px 32px;vertical-align:middle">
          <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600;font-family:Arial,sans-serif">Nueva búsqueda personalizada</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem;font-family:Arial,sans-serif">InmobIA — Panel de propiedades</p>
        </td>
        <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
          <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#fff">Inmob</span><span style="font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
        </td>
      </tr></table>
    </div>
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem">${filas}</table>
    </div>
    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body></html>`;

  try {
    const emailPrincipal = db.prepare("SELECT valor FROM config_email WHERE clave = 'email_principal'").get()?.valor
      || process.env.EMAIL_PRINCIPAL;

    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    const fotosUrls = (req.files || []).map(f => `${baseUrl}/uploads/mascotas/${f.filename}`);

    const adjuntos = (req.files || []).map(f => ({
      filename: f.originalname,
      content: readFileSync(f.path).toString('base64'),
    }));

    await enviarEmail({ to: emailPrincipal, subject: `Nueva búsqueda personalizada — ${nombre || 'Cliente'}`, html, attachments: adjuntos.length ? adjuntos : undefined });

    res.json({ ok: true, fotosUrls });
  } catch (err) {
    console.error('Error enviando email búsqueda:', err.message);
    res.status(500).json({ error: 'No se pudo enviar el correo', detalle: err.message });
  }
});

// ── GET /api/email/config  (admin)
router.get('/config', authMiddleware, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT clave, valor FROM config_email').all();
  const config = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  // Parsear campos_suscriptores de JSON a array
  if (config.campos_suscriptores) {
    try { config.campos_suscriptores = JSON.parse(config.campos_suscriptores); } catch {}
  }
  res.json(config);
});

// ── PUT /api/email/config  (admin)
router.put('/config', authMiddleware, requireAdmin, (req, res) => {
  const { email_principal, campos_suscriptores, mensaje_personalizado } = req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO config_email (clave, valor) VALUES (?, ?)');

  if (email_principal !== undefined)      upsert.run('email_principal', email_principal);
  if (campos_suscriptores !== undefined)  upsert.run('campos_suscriptores', JSON.stringify(campos_suscriptores));
  if (mensaje_personalizado !== undefined) upsert.run('mensaje_personalizado', mensaje_personalizado);

  res.json({ ok: true });
});

// ── GET /api/email/suscriptores  (admin)
router.get('/suscriptores', authMiddleware, requireAdmin, (req, res) => {
  const lista = db.prepare('SELECT * FROM suscriptores_email ORDER BY creado_en DESC').all();
  res.json(lista);
});

// ── POST /api/email/suscriptores  (admin)
router.post('/suscriptores', authMiddleware, requireAdmin, (req, res) => {
  const { nombre, email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  try {
    const r = db.prepare('INSERT INTO suscriptores_email (nombre, email) VALUES (?, ?)').run(nombre || '', email);
    res.json({ id: r.lastInsertRowid, nombre, email, activo: 1 });
  } catch {
    res.status(409).json({ error: 'El correo ya existe' });
  }
});

// ── PUT /api/email/suscriptores/:id  (admin — activar/desactivar)
router.put('/suscriptores/:id', authMiddleware, requireAdmin, (req, res) => {
  const { nombre, email, activo } = req.body;
  db.prepare('UPDATE suscriptores_email SET nombre=?, email=?, activo=? WHERE id=?')
    .run(nombre, email, activo ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── DELETE /api/email/suscriptores/:id  (admin)
router.delete('/suscriptores/:id', authMiddleware, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM suscriptores_email WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
