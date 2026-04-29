import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../database.js';
import { generarToken, authMiddleware } from '../auth.js';
import { enviarCorreoResetPassword, enviarCorreoBienvenidaAsesor } from '../email.js';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '../../public/uploads');

const storageFoto = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `asesor_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadFoto = multer({ storage: storageFoto, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype)) });

const storageHero = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `hero_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadHero = multer({ storage: storageHero, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/.test(file.mimetype)) });

const storageLogo = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, `logo_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadLogo = multer({ storage: storageLogo, limits: { fileSize: 1 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp|svg/.test(file.mimetype)) });

const dpiDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'private/dpi')
  : path.join(__dirname, '../../private/dpi');
const dpiDirLegacy = path.join(__dirname, '../../private/dpi');
fs.mkdirSync(dpiDir, { recursive: true });

const storageDPI = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dpiDir),
  filename:    (req, file, cb) => cb(null, `dpi_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadDPI = multer({ storage: storageDPI, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp|pdf/.test(file.mimetype)) });

const router = Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email y contraseña requeridos' });

  // Permite login con email O con nombre de usuario
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? OR usuario = ?').get(email, email);
  if (!usuario)
    return res.status(401).json({ error: 'Credenciales incorrectas' });

  const valida = bcrypt.compareSync(password, usuario.password);
  if (!valida)
    return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = generarToken(usuario);
  res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol } });
});

// POST /api/auth/registro (solo para crear el primer admin)
router.post('/registro', (req, res) => {
  const { nombre, email, password } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });

  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existe)
    return res.status(409).json({ error: 'El email ya está registrado' });

  const hash = bcrypt.hashSync(password, 10);
  const resultado = db.prepare(
    'INSERT INTO usuarios (nombre, email, password) VALUES (?, ?, ?)'
  ).run(nombre, email, hash);

  res.status(201).json({ id: resultado.lastInsertRowid, nombre, email });
});

// Genera código único de 4 caracteres para asesores
function generarCodigoAsesor() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let codigo;
  do {
    codigo = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (db.prepare('SELECT id FROM usuarios WHERE codigo_asesor = ?').get(codigo));
  return codigo;
}

// POST /api/auth/registro-asesor (registro público de asesores)
router.post('/registro-asesor', (req, res) => {
  const { nombre, email, password, telefono, zona, operacion, tipo_asesor, nit, tipos_ranking, usuario: nombreUsuario, tipo_doc, pais_origen, sexo, referidor_codigo } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });

  const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existe)
    return res.status(409).json({ error: 'El correo ya está registrado' });

  const hash = bcrypt.hashSync(password, 10);

  // Crear slug único para la URL del asesor
  const slugBase = nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
  let slug = slugBase;
  let slugN = 2;
  while (db.prepare('SELECT id FROM usuarios WHERE slug = ?').get(slug)) {
    slug = slugBase + '-' + slugN++;
  }

  const codigoAsesor = generarCodigoAsesor();

  // Resolver referidor si se envió un código
  let referidorId = null;
  let referidorData = null;
  if (referidor_codigo) {
    const codigoBuscar = referidor_codigo.startsWith('A') ? referidor_codigo.slice(1) : referidor_codigo;
    referidorData = db.prepare('SELECT id, nombre FROM usuarios WHERE codigo_asesor = ?').get(codigoBuscar);
    if (referidorData) referidorId = referidorData.id;
  }

  const resultado = db.prepare(
    'INSERT INTO usuarios (nombre, email, password, rol, telefono, zona, operacion, slug, tipo_asesor, nit, tipos_ranking, usuario, tipo_doc, pais_origen, codigo_asesor, sexo, referidor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(nombre, email, hash, 'asesor', telefono || '', zona || '', operacion || 'ambas', slug, tipo_asesor || 'independiente', nit || '', tipos_ranking ? JSON.stringify(tipos_ranking) : '', nombreUsuario || '', tipo_doc || 'dpi', pais_origen || '', codigoAsesor, sexo || '', referidorId);

  // ── RECOMPENSA +2 LEADS AL REFERIDOR ──────────────────────────
  if (referidorId) {
    db.prepare(`UPDATE usuarios SET leads_bonus_referidos = leads_bonus_referidos + 2 WHERE id = ?`)
      .run(referidorId);

    db.prepare(`
      INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, creado_en)
      VALUES (?, 'nuevo_referido', '¡Nuevo referido registrado!', ?, datetime('now'))
    `).run(
      referidorId,
      `${nombre} se registró con tu enlace. Tienes +2 leads disponibles este mes.`
    );
  }

  const usuario = { id: resultado.lastInsertRowid, nombre, email, rol: 'asesor' };
  const token = generarToken(usuario);

  enviarCorreoBienvenidaAsesor({ email, nombre, slug }).catch(e =>
    console.error('⚠️  Bienvenida no enviada:', e.message)
  );

  res.status(201).json({ token, usuario });
});

// GET /api/auth/mis-referidos  (protegida)
router.get('/mis-referidos', authMiddleware, (req, res) => {
  const asesorId = req.usuario.id;
  const yo = db.prepare('SELECT codigo_asesor FROM usuarios WHERE id = ?').get(asesorId);
  const referidos = db.prepare(`
    SELECT u.id, u.nombre, u.foto, u.plan, u.creado_en,
           (SELECT COUNT(*) FROM propiedades WHERE usuario_id = u.id AND estado = 'activo') AS props_activas
    FROM usuarios u
    WHERE u.referidor_id = ?
    ORDER BY u.creado_en DESC
  `).all(asesorId);
  res.json({ codigo_asesor: yo?.codigo_asesor || null, referidos });
});

// GET /api/auth/notificaciones  (protegida)
router.get('/notificaciones', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT id, tipo, titulo, mensaje, leida, creado_en
    FROM notificaciones WHERE usuario_id = ?
    ORDER BY creado_en DESC LIMIT 50
  `).all(req.usuario.id);
  res.json(rows);
});

// POST /api/auth/notificaciones/:id/leer  (protegida)
router.post('/notificaciones/:id/leer', authMiddleware, (req, res) => {
  db.prepare(`UPDATE notificaciones SET leida = 1 WHERE id = ? AND usuario_id = ?`)
    .run(req.params.id, req.usuario.id);
  res.json({ ok: true });
});

// GET /api/auth/me  (protegida)
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const u = db.prepare('SELECT id, nombre, email, rol, telefono, zona, tipo_asesor, nit, usuario, bio, foto, logo, empresa, plan, score, slug, tipos_ranking, tipo_doc, pais_origen, hero_color_izq, hero_color_der, hero_imagen, hero_opacidad, btn_estilo, btn_whatsapp, btn_agendar, btn_mensaje, red_fb, red_ig, red_tiktok, red_linkedin, vis_fb, vis_ig, vis_tiktok, vis_linkedin, servicios_activo, servicios_titulo, servicios_data, testimonios_activo, testimonios_titulo, testimonios_data, permitir_similares_otros, creado_en, codigo_asesor, premium_estado, premium_activado_en, premium_renovacion_en, recurrente_subscription_id, dpi_archivo, dpi_subido_en, dpi_estado, dpi_rechazado_razon, acred_cbr, acred_cbr_codigo, acred_gpi, acred_gpi_codigo, mostrar_zonas, puede_plus_one, plus_one_aprobado_en, plus_one_notas FROM usuarios WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(u);
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/score-detalle  — calcula el score InmobIA del mes actual (9 áreas)
router.get('/score-detalle', authMiddleware, (req, res) => {
  try {
  const asesorId = req.usuario.id;
  const mes = new Date().toISOString().slice(0, 7); // '2026-04'
  const inicioMes = mes + '-01 00:00:00';
  const mesPasadoDate = new Date(); mesPasadoDate.setMonth(mesPasadoDate.getMonth() - 1);
  const mesPasado = mesPasadoDate.toISOString().slice(0, 7);
  const inicioMesPasado = mesPasado + '-01 00:00:00';
  const finMesPasado = mes + '-01 00:00:00';

  // 1. Perfil completo (Tipo A — snapshot) — 9 campos base (incl. foto + documento DPI/Pasaporte). Acreditaciones excluidas.
  const u = db.prepare('SELECT nombre, email, telefono, zona, bio, foto, empresa, tipos_ranking, dpi_archivo FROM usuarios WHERE id = ?').get(asesorId);
  const camposPerfilLabels = {
    nombre: 'Nombre', email: 'Email', telefono: 'WhatsApp', zona: 'Zonas de trabajo',
    bio: 'Biografía', foto: 'Foto de perfil', empresa: 'Empresa/Inmobiliaria', tipos_ranking: 'Especialidades',
    dpi_archivo: 'Documento DPI/Pasaporte'
  };
  const camposPerfil = Object.keys(camposPerfilLabels);
  const faltantes = camposPerfil.filter(c => !u[c] || !String(u[c]).trim() || String(u[c]) === '[]' || String(u[c]) === 'null');
  const llenos = camposPerfil.length - faltantes.length;
  const totalCampos = 9;
  const areaPerfil = Math.round((llenos / totalCampos) * 5 * 10) / 10;

  // 2. Propiedades con 5+ fotos (Tipo A — snapshot)
  const propsRaw = db.prepare(`
    SELECT p.id, COUNT(i.id) as cnt
    FROM propiedades p
    LEFT JOIN imagenes i ON i.propiedad_id = p.id
    WHERE p.usuario_id = ?
    GROUP BY p.id
  `).all(asesorId);
  const props5fotos = propsRaw.filter(p => p.cnt >= 5).length;
  const areaPropiedades = Math.round(Math.min(props5fotos / 2, 1) * 5 * 10) / 10;

  // 3. Cierres — usa el mes actual si hay datos, sino el mes anterior (para no arrancar en 0 el día 1)
  const cierresActual = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND etapa = 'cerrado' AND cerrado_en >= ?`).get(asesorId, inicioMes).c;
  const cierresPasado  = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND etapa = 'cerrado' AND cerrado_en >= ? AND cerrado_en < ?`).get(asesorId, inicioMesPasado, finMesPasado).c;
  const cierres = cierresActual > 0 ? cierresActual : cierresPasado;
  const areaCierres = cierres === 0 ? 0 : cierres === 1 ? 2.5 : cierres === 2 ? 4 : 5;

  // 4. Calificaciones de clientes (Tipo B — umbral sobre promedio)
  // Lee desde la tabla calificaciones (fuente primaria) y como fallback leads.calificacion_cliente
  const calRow = db.prepare(`
    SELECT AVG(c.estrellas) as avg FROM calificaciones c
    JOIN leads l ON l.id = c.lead_id
    WHERE l.asesor_id = ? AND c.creado_en >= ?
  `).get(asesorId, inicioMes);
  const calAvg = calRow?.avg || 0;
  const areaCali = calAvg === 0 ? 0 : calAvg < 2 ? 1 : calAvg < 3 ? 2 : calAvg < 4 ? 3 : calAvg < 4.5 ? 4 : 5;

  // 5. Visitas atendidas (Tipo B — proporcional)
  const visitasTotal = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND fecha_visita >= ? AND fecha_visita <= datetime('now')`).get(asesorId, inicioMes).c;
  const visitasAtend  = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND fecha_visita >= ? AND fecha_visita <= datetime('now') AND etapa NOT IN ('inactivo','nuevo')`).get(asesorId, inicioMes).c;
  const areaVisitas = visitasTotal === 0 ? 0 : Math.round((visitasAtend / visitasTotal) * 5 * 10) / 10;

  // 6. Leads gestionados / actualizados (Tipo B — proporcional)
  const leadsTotal = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND creado_en >= ?`).get(asesorId, inicioMes).c;
  const leadsGest  = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND creado_en >= ? AND etapa NOT IN ('nuevo')`).get(asesorId, inicioMes).c;
  const areaLeads = leadsTotal === 0 ? 0 : Math.round((leadsGest / leadsTotal) * 5 * 10) / 10;

  // 7. Respuesta rápida — leads respondidos en <2h (Tipo B — proporcional)
  const respondidos = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND creado_en >= ? AND actualizado_en IS NOT NULL AND etapa NOT IN ('nuevo')`).get(asesorId, inicioMes).c;
  const rapidosMenos2h = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND creado_en >= ? AND actualizado_en IS NOT NULL AND etapa NOT IN ('nuevo') AND (julianday(actualizado_en) - julianday(creado_en)) * 1440 < 20`).get(asesorId, inicioMes).c;
  const areaRespuesta = respondidos === 0 ? 0 : Math.round((rapidosMenos2h / respondidos) * 5 * 10) / 10;

  // 8. Referidos activos este mes (Tipo B — umbral)
  const refCount = db.prepare(`SELECT COUNT(*) as c FROM usuarios WHERE referidor_id = ? AND creado_en >= ?`).get(asesorId, inicioMes).c;
  const areaReferidos = refCount === 0 ? 0 : refCount === 1 ? 2.5 : refCount === 2 ? 4 : 5;

  // 9. Cierres colaborativos (Tipo B — umbral)
  const colab = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE asesor_id = ? AND etapa = 'cerrado' AND modelo IN ('4T','5RA') AND cerrado_en >= ?`).get(asesorId, inicioMes).c;
  const areaColab = colab === 0 ? 0 : colab === 1 ? 3 : 5;

  // Score final = promedio de las 9 áreas (0–5★)
  const areasArr = [areaPerfil, areaPropiedades, areaCierres, areaCali, areaVisitas, areaLeads, areaRespuesta, areaReferidos, areaColab];
  const scoreFinal = Math.round(areasArr.reduce((a, b) => a + b, 0) / areasArr.length * 10) / 10;

  // Guardar en historial (upsert) y actualizar usuarios.score
  db.prepare(`
    INSERT OR REPLACE INTO score_mensual
      (asesor_id, mes, score_final, area_perfil, area_propiedades, area_cierres, area_calificaciones, area_visitas, area_leads, area_respuesta, area_referidos, area_colaborativos, calculado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(asesorId, mes, scoreFinal, areaPerfil, areaPropiedades, areaCierres, areaCali, areaVisitas, areaLeads, areaRespuesta, areaReferidos, areaColab);

  db.prepare('UPDATE usuarios SET score = ? WHERE id = ?').run(scoreFinal, asesorId);

  // Historial últimos 3 meses
  const historial = db.prepare(`
    SELECT mes, score_final, area_perfil, area_propiedades, area_cierres, area_calificaciones,
           area_visitas, area_leads, area_respuesta, area_referidos, area_colaborativos
    FROM score_mensual WHERE asesor_id = ? ORDER BY mes DESC LIMIT 4
  `).all(asesorId);

  res.json({
    mes, score: scoreFinal,
    areas: {
      perfil:         { stars: areaPerfil,      label: 'Perfil completo',           meta: faltantes.length === 0 ? '9/9 campos completos ✓' : `${llenos}/${totalCampos} · Falta: ${faltantes.map(c => camposPerfilLabels[c]).join(', ')}`, accion: 'perfil' },
      propiedades:    { stars: areaPropiedades,  label: 'Propiedades con 5+ fotos',  meta: `${props5fotos}/2 propiedades`, props5fotos, accion: 'propiedades' },
      cierres:        { stars: areaCierres,      label: 'Promedio de cierres',           meta: `${cierres} cierre${cierres !== 1 ? 's' : ''}${cierresActual === 0 && cierresPasado > 0 ? ' (mes anterior)' : ''}`, accion: 'crm' },
      calificaciones: { stars: areaCali,         label: 'Calificación de clientes',  meta: calAvg > 0 ? `${Math.round(calAvg*10)/10}★ promedio` : 'Sin calificaciones', accion: null },
      visitas:        { stars: areaVisitas,       label: 'Visitas atendidas',         meta: visitasTotal > 0 ? `${visitasAtend}/${visitasTotal} visitas` : 'Sin visitas este mes', accion: 'crm' },
      leads:          { stars: areaLeads,         label: 'Leads actualizados',        meta: leadsTotal > 0 ? `${leadsGest}/${leadsTotal} leads gestionados` : 'Sin leads este mes', accion: 'crm' },
      respuesta:      { stars: areaRespuesta,     label: 'Respuesta en <20 min',      meta: respondidos > 0 ? `${rapidosMenos2h}/${respondidos} respondidos rápido` : 'Sin datos aún', accion: 'crm' },
      referidos:      { stars: areaReferidos,     label: 'Referidos activos',         meta: `${refCount} referido${refCount !== 1 ? 's' : ''} este mes`, accion: 'referidos' },
      colaborativos:  { stars: areaColab,         label: 'Cierres colaborativos',     meta: `${colab} cierre${colab !== 1 ? 's' : ''} colaborativo${colab !== 1 ? 's' : ''}`, accion: 'requerimientos' },
    },
    historial,
  });
  } catch (e) { console.error('score-detalle crash:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/auth/leads-stats  (estadísticas de leads del mes para el asesor)
router.get('/leads-stats', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const u = db.prepare('SELECT plan, creado_en, leads_bonus_referidos FROM usuarios WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const now = new Date();
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const leads_este_mes = db.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE asesor_id = ? AND creado_en >= ?`
    ).get(id, mesInicio)?.n || 0;

    const props_inmobia = db.prepare(
      `SELECT COUNT(*) AS n FROM propiedades WHERE usuario_id = ? AND publicado_inmobia = 1 AND estado = 'activo'`
    ).get(id)?.n || 0;

    const creadoEn = new Date(u.creado_en || now);
    const diasRegistrado = (now - creadoEn) / (1000 * 60 * 60 * 24);
    const es_primer_mes = diasRegistrado <= 30;

    const leads_extra        = es_primer_mes ? Math.floor(props_inmobia / 5) : 0;
    const leads_bonus_ref    = u.leads_bonus_referidos || 0;
    const limite_base        = 6;
    const limite_total       = limite_base + leads_extra + leads_bonus_ref;

    res.json({ leads_este_mes, props_inmobia, leads_extra, leads_bonus_ref, limite_base, limite_total, es_primer_mes, plan: u.plan });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/perfil  (protegida)
router.put('/perfil', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { nombre, telefono, bio, zona, tipo_asesor, empresa, tipos_ranking, cuenta_banco, cuenta_numero, cuenta_tipo, cuenta_titular, acred_cbr, acred_cbr_codigo, acred_gpi, acred_gpi_codigo, mostrar_zonas, nit, tipo_doc } = req.body;
    const cur = db.prepare('SELECT nombre, telefono, bio, zona, tipo_asesor, empresa, tipos_ranking, cuenta_banco, cuenta_numero, cuenta_tipo, cuenta_titular, mostrar_zonas, acred_cbr, acred_cbr_codigo, acred_gpi, acred_gpi_codigo, nit, tipo_doc FROM usuarios WHERE id=?').get(id) || {};
    db.prepare('UPDATE usuarios SET nombre=?, telefono=?, bio=?, zona=?, tipo_asesor=?, empresa=?, tipos_ranking=?, cuenta_banco=?, cuenta_numero=?, cuenta_tipo=?, cuenta_titular=?, acred_cbr=?, acred_cbr_codigo=?, acred_gpi=?, acred_gpi_codigo=?, mostrar_zonas=?, nit=?, tipo_doc=? WHERE id=?')
      .run(
        nombre    !== undefined ? (nombre    || '') : (cur.nombre    || ''),
        telefono  !== undefined ? (telefono  || '') : (cur.telefono  || ''),
        bio       !== undefined ? (bio       || '') : (cur.bio       || ''),
        zona      !== undefined ? (zona      || '') : (cur.zona      || ''),
        tipo_asesor !== undefined ? (tipo_asesor || 'independiente') : (cur.tipo_asesor || 'independiente'),
        empresa   !== undefined ? (empresa   || '') : (cur.empresa   || ''),
        tipos_ranking   !== undefined ? tipos_ranking   : (cur.tipos_ranking  || ''),
        cuenta_banco    !== undefined ? cuenta_banco    : (cur.cuenta_banco   || ''),
        cuenta_numero   !== undefined ? cuenta_numero   : (cur.cuenta_numero  || ''),
        cuenta_tipo     !== undefined ? cuenta_tipo     : (cur.cuenta_tipo    || 'monetaria'),
        cuenta_titular  !== undefined ? cuenta_titular  : (cur.cuenta_titular || ''),
        acred_cbr       !== undefined ? (acred_cbr ? 1 : 0)        : (cur.acred_cbr       ?? 0),
        acred_cbr_codigo !== undefined ? (acred_cbr_codigo || '')   : (cur.acred_cbr_codigo || ''),
        acred_gpi       !== undefined ? (acred_gpi ? 1 : 0)        : (cur.acred_gpi       ?? 0),
        acred_gpi_codigo !== undefined ? (acred_gpi_codigo || '')   : (cur.acred_gpi_codigo || ''),
        mostrar_zonas   !== undefined ? (mostrar_zonas ? 1 : 0)    : (cur.mostrar_zonas    ?? 1),
        nit             !== undefined ? (nit || '')                 : (cur.nit              || ''),
        tipo_doc        !== undefined ? (tipo_doc || 'dpi')         : (cur.tipo_doc         || 'dpi'),
        id
      );
    res.json({ mensaje: 'Perfil actualizado' });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PATCH /api/auth/permitir-similares  (toggle del modelo tripartito)
router.patch('/permitir-similares', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { permitir } = req.body;
    db.prepare('UPDATE usuarios SET permitir_similares_otros = ? WHERE id = ?').run(permitir ? 1 : 0, id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// POST /api/auth/foto  (protegida — sube foto de perfil del asesor)
router.post('/foto', uploadFoto.single('foto'), (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    const fotoUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE usuarios SET foto=? WHERE id=?').run(fotoUrl, id);
    res.json({ foto: fotoUrl });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// POST /api/auth/dpi  (protegida — sube documento de identidad del asesor con validación de imagen)
router.post('/dpi', uploadDPI.single('dpi'), async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  let id;
  try {
    ({ id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024'));
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  const filePath = req.file.path;
  const esPDF = req.file.mimetype === 'application/pdf';

  // PDFs: solo guardar sin análisis visual
  if (esPDF) {
    try {
      db.prepare("UPDATE usuarios SET dpi_archivo=?, dpi_subido_en=datetime('now') WHERE id=?")
        .run(`private/dpi/${req.file.filename}`, id);
      return res.json({ ok: true, tipo: 'pdf' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Análisis de imagen con Sharp
  try {
    // Rotar automáticamente según EXIF (fotos de celular)
    const rotated = sharp(filePath).rotate();
    const meta = await rotated.metadata();
    const w = meta.width;
    const h = meta.height;

    // 1. Dimensiones mínimas
    if (w < 300 || h < 200) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: `Imagen muy pequeña (${w}×${h}px). Suba una foto más nítida del documento.` });
    }

    // 2. Aspect ratio — aceptamos landscape (DPI/tarjeta), portrait (pasaporte o foto con ambas caras)
    const ratio = w / h;
    const esLandscapeDoc = ratio >= 1.0  && ratio <= 2.5;   // DPI solo o landscape
    const esPortraitDoc  = ratio >= 0.35 && ratio < 1.0;    // Pasaporte, foto con ambas caras, imagen vertical
    if (!esLandscapeDoc && !esPortraitDoc) {
      fs.unlinkSync(filePath);
      return res.status(422).json({
        error: `La proporción de la imagen (${ratio.toFixed(2)}:1) no parece corresponder a un documento. Fotografíe el DPI o pasaporte completo.`
      });
    }

    // 3. Análisis de píxeles — muestra 300×200 aplicando rotación EXIF
    const sampleW = 300, sampleH = 200;
    const { data } = await sharp(filePath)
      .rotate()
      .resize(sampleW, sampleH, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const px = data;
    const total = sampleW * sampleH;
    let brightPx = 0, darkPx = 0, sumLum = 0;
    let dpiCyanZonePx = 0, dpiCyanAnyPx = 0, cyanZoneTotal = 0;
    let pinkPx = 0, greenPx = 0;
    const lumValues = [];

    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        const i = (y * sampleW + x) * 3;
        const r = px[i], g = px[i+1], b = px[i+2];
        const lum = 0.299*r + 0.587*g + 0.114*b;
        sumLum += lum;
        lumValues.push(lum);
        if (lum > 185) brightPx++;
        if (lum < 60)  darkPx++;

        // Cyan/turquesa DPI Guatemala: R<185, G y B altos y cercanos entre sí, ambos >> R
        // Captura tanto el encabezado claro (#6DC4D8) como la marca de agua del mapa
        const esDpiCyan = r < 185 && g > 125 && b > 125 && b > r + 30 && Math.abs(b - g) < 70;
        if (y < sampleH * 0.50) {
          cyanZoneTotal++;
          if (esDpiCyan) dpiCyanZonePx++;
        }
        if (esDpiCyan) dpiCyanAnyPx++;

        // Rosa/salmón (patentes de comercio)
        if (lum > 120 && r > b + 35 && r > g + 10) pinkPx++;
        // Verde dominante (documentos no-DPI)
        if (lum > 100 && g > r + 25 && g > b + 25) greenPx++;
      }
    }

    const pctBright       = brightPx / total;
    const pctDark         = darkPx / total;
    const dpiCyanZoneRatio = cyanZoneTotal > 0 ? dpiCyanZonePx / cyanZoneTotal : 0;
    const dpiCyanAnyRatio  = dpiCyanAnyPx / total;
    const pinkRatio        = pinkPx / total;
    const greenRatio       = greenPx / total;
    const lumMean = sumLum / total;
    const lumStd  = Math.sqrt(lumValues.reduce((acc, v) => acc + (v - lumMean) ** 2, 0) / total);

    // 4. Rechazos directos
    if (pctBright < 0.10 && dpiCyanAnyRatio < 0.04) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: 'La imagen es muy oscura. Tome la foto en un lugar con buena iluminación.' });
    }
    if (lumStd < 8) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: 'La imagen parece ser de un solo color. Suba una foto clara del documento.' });
    }
    // Color dominante incompatible con DPI/pasaporte guatemalteco
    if (pinkRatio > 0.25 && dpiCyanAnyRatio < 0.05) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: 'El documento parece ser una patente u otro documento comercial. Suba su DPI o pasaporte personal vigente.' });
    }
    if (greenRatio > 0.20 && dpiCyanAnyRatio < 0.05) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: 'El documento no parece ser un DPI o pasaporte. Suba su documento de identificación personal vigente.' });
    }

    // 5. Score — el cyan DPI Guatemala es el indicador principal
    let score = 0;
    if (w >= 600 || h >= 400)                           score += 15; // Resolución mínima
    if (pctBright >= 0.20)                              score += 10; // Fondo claro
    if (pctDark >= 0.02 && pctDark <= 0.50)             score += 10; // Texto visible
    if (lumStd >= 20)                                   score += 10; // Variación de colores
    if (dpiCyanZoneRatio >= 0.06)                       score += 40; // Cyan DPI en mitad superior ← clave
    if (dpiCyanAnyRatio >= 0.04)                        score += 20; // Cyan DPI en cualquier parte
    if (esLandscapeDoc && ratio >= 1.4 && ratio <= 1.8)  score += 15; // Proporción exacta tarjeta DPI
    if (esPortraitDoc)                                  score += 10; // Foto de dos caras / pasaporte

    if (score < 25) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: 'La imagen no parece ser un documento de identificación. Suba una foto clara de su DPI o pasaporte con buena iluminación.' });
    }

    // Guardado exitoso — estado 'pendiente' hasta verificación manual del equipo InmobIA
    db.prepare("UPDATE usuarios SET dpi_archivo=?, dpi_subido_en=datetime('now'), dpi_estado='pendiente', dpi_rechazado_razon=NULL WHERE id=?")
      .run(`private/dpi/${req.file.filename}`, id);

    const tipo = dpiCyanZoneRatio >= 0.06 ? 'dpi_guatemala' : esPortraitDoc ? 'pasaporte' : 'tarjeta_id';
    res.json({ ok: true, tipo, confianza: Math.min(100, score), estado: 'pendiente' });

  } catch (e) {
    try { fs.unlinkSync(filePath); } catch {}
    console.error('DPI análisis error:', e.message);
    res.status(500).json({ error: 'Error al procesar el documento: ' + e.message });
  }
});

// POST /api/auth/hero-imagen  (protegida — sube imagen de fondo del hero)
router.post('/hero-imagen', uploadHero.single('hero_imagen'), (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
    const url = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE usuarios SET hero_imagen=? WHERE id=?').run(url, id);
    res.json({ hero_imagen: url });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// DELETE /api/auth/hero-imagen  (protegida — elimina imagen de fondo)
router.delete('/hero-imagen', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    db.prepare('UPDATE usuarios SET hero_imagen=NULL WHERE id=?').run(id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/hero-imagen-url  (protegida — guarda URL de fondo de galería)
router.put('/hero-imagen-url', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { hero_imagen } = req.body;
    db.prepare('UPDATE usuarios SET hero_imagen=? WHERE id=?').run(hero_imagen || null, id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/hero-colors  (protegida — guarda colores del hero del portal)
router.put('/hero-colors', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { hero_color_izq, hero_color_der } = req.body;
    db.prepare('UPDATE usuarios SET hero_color_izq=?, hero_color_der=? WHERE id=?')
      .run(hero_color_izq || '#1e2d4a', hero_color_der || '#2a3f6b', id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/hero-opacidad  (protegida — guarda opacidad del overlay del hero)
router.put('/hero-opacidad', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const val = parseFloat(req.body.hero_opacidad);
    if (isNaN(val) || val < 0 || val > 1) return res.status(400).json({ error: 'Valor inválido' });
    db.prepare('UPDATE usuarios SET hero_opacidad=? WHERE id=?').run(val, id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// POST /api/auth/logo  (protegida — sube logo de la inmobiliaria/asesor)
router.post('/logo', uploadLogo.single('logo'), (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    const logoUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE usuarios SET logo=? WHERE id=?').run(logoUrl, id);
    res.json({ logo: logoUrl });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// DELETE /api/auth/logo  (protegida — elimina el logo)
router.delete('/logo', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    db.prepare('UPDATE usuarios SET logo=NULL WHERE id=?').run(id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/asesor/:id/logo  (pública — solo logo y slug del asesor)
router.get('/asesor/:id/logo', (req, res) => {
  const u = db.prepare('SELECT logo, slug, telefono, nombre, foto, bio, empresa, plan, codigo_asesor FROM usuarios WHERE id = ? AND rol = ?').get(req.params.id, 'asesor');
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  res.json(u);
});

// GET /api/auth/asesor/by-slug/:slug  (pública — info básica del asesor por slug)
router.get('/asesor/by-slug/:slug', (req, res) => {
  const u = db.prepare('SELECT id, nombre, slug, telefono, codigo_asesor FROM usuarios WHERE slug = ? AND rol = ?').get(req.params.slug, 'asesor');
  if (!u) return res.status(404).json({ error: 'No encontrado' });
  res.json(u);
});

// PUT /api/auth/redes-sociales  (protegida — guarda URLs y visibilidad de redes)
router.put('/redes-sociales', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { red_fb, red_ig, red_tiktok, red_linkedin, vis_fb, vis_ig, vis_tiktok, vis_linkedin } = req.body;
    db.prepare('UPDATE usuarios SET red_fb=?, red_ig=?, red_tiktok=?, red_linkedin=?, vis_fb=?, vis_ig=?, vis_tiktok=?, vis_linkedin=? WHERE id=?')
      .run(red_fb || '', red_ig || '', red_tiktok || '', red_linkedin || '', vis_fb ? 1 : 0, vis_ig ? 1 : 0, vis_tiktok ? 1 : 0, vis_linkedin ? 1 : 0, id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/btn-config  (protegida — guarda estilo y visibilidad de botones)
router.put('/btn-config', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { btn_estilo, btn_whatsapp, btn_agendar, btn_mensaje } = req.body;
    db.prepare('UPDATE usuarios SET btn_estilo=?, btn_whatsapp=?, btn_agendar=?, btn_mensaje=? WHERE id=?')
      .run(btn_estilo || 'color', btn_whatsapp ? 1 : 0, btn_agendar ? 1 : 0, btn_mensaje ? 1 : 0, id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/portal/:slug  (pública — perfil del asesor + sus propiedades)
router.get('/portal/:slug', (req, res) => {
  const u = db.prepare(
    'SELECT id, nombre, bio, foto, logo, empresa, telefono, zona, tipo_asesor, tipos_ranking, plan, score, slug, hero_color_izq, hero_color_der, hero_imagen, hero_opacidad, btn_estilo, btn_whatsapp, btn_agendar, btn_mensaje, red_fb, red_ig, red_tiktok, red_linkedin, vis_fb, vis_ig, vis_tiktok, vis_linkedin, servicios_activo, servicios_titulo, servicios_data, testimonios_activo, testimonios_titulo, testimonios_data, permitir_similares_otros, creado_en, acred_cbr, acred_cbr_codigo, acred_gpi, acred_gpi_codigo, mostrar_zonas, dpi_archivo FROM usuarios WHERE slug = ? AND rol = ?'
  ).get(req.params.slug, 'asesor');
  if (!u) return res.status(404).json({ error: 'Asesor no encontrado' });

  const propPropias = db.prepare(`
    SELECT p.*, (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
    (SELECT COUNT(*) FROM imagenes WHERE propiedad_id = p.id) AS total_imagenes
    FROM propiedades p
    WHERE p.usuario_id = ? AND p.estado IN ('activo','pendiente')
    ORDER BY p.publicado_inmobia DESC, p.creado_en DESC
  `).all(u.id);

  // Incluir propiedades 1D de InmobIA que el asesor ha solicitado
  const prop1D = db.prepare(`
    SELECT p.*, (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
    (SELECT COUNT(*) FROM imagenes WHERE propiedad_id = p.id) AS total_imagenes
    FROM propiedades p
    JOIN solicitudes_1d s ON s.propiedad_id = p.id AND s.asesor_id = ?
    WHERE s.estado = 'activa' AND p.compartido_1d = 1 AND p.estado IN ('activo','pendiente')
    ORDER BY p.creado_en DESC
  `).all(u.id);

  const prop1DMarked = prop1D.map(p => ({ ...p, _1d: true }));
  const propiedades = [...propPropias, ...prop1DMarked];

  res.json({ asesor: u, propiedades });
});

// PUT /api/auth/servicios  (protegida)
router.put('/servicios', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { servicios_activo, servicios_titulo, servicios_data } = req.body;
    db.prepare('UPDATE usuarios SET servicios_activo=?, servicios_titulo=?, servicios_data=? WHERE id=?')
      .run(servicios_activo ? 1 : 0, servicios_titulo || 'Mis Servicios', JSON.stringify(servicios_data || []), id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PUT /api/auth/testimonios  (protegida)
router.put('/testimonios', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const { id } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const { testimonios_activo, testimonios_titulo, testimonios_data } = req.body;
    db.prepare('UPDATE usuarios SET testimonios_activo=?, testimonios_titulo=?, testimonios_data=? WHERE id=?')
      .run(testimonios_activo ? 1 : 0, testimonios_titulo || 'Testimonios', JSON.stringify(testimonios_data || []), id);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// ── ADMIN: listar asesores ────────────────────────────────────
// GET /api/auth/admin/asesores
router.get('/admin/asesores', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const asesores = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.usuario, u.telefono, u.plan, u.rol, u.creado_en, u.codigo_asesor,
             u.puede_plus_one, u.plus_one_aprobado_en, u.plus_one_notas,
             u.score,
             COUNT(p.id) AS num_propiedades,
             COUNT(CASE WHEN p.publicado_inmobia = 1 THEN 1 END) AS num_propiedades_inmobia,
             COUNT(CASE WHEN p.origen_comision = 'plus_one' THEN 1 END) AS num_propiedades_plus_one
      FROM usuarios u
      LEFT JOIN propiedades p ON p.usuario_id = u.id
      WHERE u.rol = 'asesor'
      GROUP BY u.id
      ORDER BY u.creado_en DESC
    `).all();
    res.json({ asesores });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/asesores/buscar?codigo=XXXX  (cualquier asesor autenticado busca a un colega por código)
router.get('/asesores/buscar', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const yo = db.prepare('SELECT id, rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!yo) return res.status(401).json({ error: 'Usuario no encontrado' });
    const { codigo } = req.query;
    if (!codigo || codigo.trim().length < 2) return res.status(400).json({ error: 'Código muy corto' });
    const u = db.prepare(`
      SELECT id, nombre, zona, plan, slug, codigo_asesor,
             COUNT(p.id) AS num_propiedades
      FROM usuarios u
      LEFT JOIN propiedades p ON p.usuario_id = u.id
      WHERE u.rol = 'asesor' AND UPPER(u.codigo_asesor) = UPPER(?) AND u.id != ?
      GROUP BY u.id
    `).get(codigo.trim(), yo.id);
    if (!u) return res.status(404).json({ error: 'Asesor no encontrado con ese código' });
    res.json(u);
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/admin/asesores/:id  (admin — perfil completo de un asesor)
router.get('/admin/asesores/:id', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    const u = db.prepare(`
      SELECT u.id, u.nombre, u.email, u.usuario, u.telefono, u.plan, u.creado_en,
             u.codigo_asesor, u.slug, u.bio, u.empresa, u.zona, u.score,
             u.puede_plus_one, u.plus_one_aprobado_en, u.plus_one_notas,
             COUNT(p.id) AS num_propiedades,
             COUNT(CASE WHEN p.origen_comision = 'plus_one' THEN 1 END) AS num_propiedades_plus_one
      FROM usuarios u
      LEFT JOIN propiedades p ON p.usuario_id = u.id
      WHERE u.id = ? AND u.rol = 'asesor'
      GROUP BY u.id
    `).get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Asesor no encontrado' });
    res.json(u);
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// DELETE /api/auth/admin/asesores/:id
router.delete('/admin/asesores/:id', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    const r = db.prepare('DELETE FROM usuarios WHERE id = ? AND rol = ?').run(req.params.id, 'asesor');
    if (r.changes === 0) return res.status(404).json({ error: 'Asesor no encontrado' });
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PATCH /api/auth/admin/asesores/:id/plan
router.patch('/admin/asesores/:id/plan', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const { plan } = req.body;
    if (!['gratis', 'premium'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
    db.prepare('UPDATE usuarios SET plan = ? WHERE id = ? AND rol = ?').run(plan, req.params.id, 'asesor');
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// POST /api/auth/solicitar-reset — solicita enlace de recuperación de contraseña
router.post('/solicitar-reset', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  const usuario = db.prepare("SELECT id, nombre, email, rol FROM usuarios WHERE LOWER(email) = LOWER(?)").get(email.trim());
  // Responder siempre OK para no revelar si el email existe
  if (!usuario) return res.json({ ok: true });

  // Invalidar tokens anteriores del mismo email
  db.prepare("UPDATE password_resets SET usado = 1 WHERE email = LOWER(?)").run(email.trim().toLowerCase());

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora
  db.prepare("INSERT INTO password_resets (email, token, expira_en) VALUES (?, ?, ?)").run(usuario.email.toLowerCase(), token, expira);

  const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
  const pagina = usuario.rol === 'admin' ? 'admin.html' : 'asesores.html';
  const linkReset = `${BASE_URL}/${pagina}?token=${token}`;

  const r = await enviarCorreoResetPassword({ email: usuario.email, nombre: usuario.nombre, linkReset });
  if (r.ok) console.log('📧 Correo de reset enviado a', usuario.email);
  else console.error('⚠️  No se pudo enviar reset a', usuario.email, r.error);
  res.json({ ok: true });
});

// POST /api/auth/reset-password — aplica la nueva contraseña con el token
router.post('/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const reset = db.prepare("SELECT * FROM password_resets WHERE token = ? AND usado = 0").get(token);
  if (!reset) return res.status(400).json({ error: 'El enlace es inválido o ya fue usado' });
  if (new Date(reset.expira_en) < new Date()) return res.status(400).json({ error: 'El enlace expiró — solicita uno nuevo' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE usuarios SET password = ? WHERE LOWER(email) = ?").run(hash, reset.email);
  db.prepare("UPDATE password_resets SET usado = 1 WHERE token = ?").run(token);

  res.json({ ok: true });
});

// ── GET /api/auth/mis-calificaciones  (resumen y lista de calificaciones del asesor)
router.get('/mis-calificaciones', authMiddleware, (req, res) => {
  const asesorId = req.usuario.id;

  const calificaciones = db.prepare(`
    SELECT c.id, c.estrellas, c.razones, c.comentario, c.creado_en,
      l.nombre AS cliente_nombre,
      p.titulo AS propiedad_titulo, p.zona AS propiedad_zona,
      l.encuesta_interes, l.encuesta_estrellas, l.encuesta_razones, l.encuesta_comentario
    FROM calificaciones c
    LEFT JOIN leads l ON l.id = c.lead_id
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE c.asesor_id = ?
    ORDER BY c.creado_en DESC
  `).all(asesorId);

  const total = calificaciones.length;
  const promedio = total
    ? (calificaciones.reduce((s, c) => s + c.estrellas, 0) / total).toFixed(1)
    : null;

  const distribucion = [5, 4, 3, 2, 1].map(n => ({
    estrellas: n,
    cantidad: calificaciones.filter(c => c.estrellas === n).length
  }));

  // Razones más frecuentes
  const razonesCont = {};
  calificaciones.forEach(c => {
    try {
      const raz = JSON.parse(c.razones || '[]');
      if (Array.isArray(raz)) raz.forEach(r => { razonesCont[r] = (razonesCont[r] || 0) + 1; });
    } catch {}
  });
  const topRazones = Object.entries(razonesCont)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([razon, cantidad]) => ({ razon, cantidad }));

  res.json({ calificaciones, total, promedio, distribucion, topRazones });
});

// ── ADMIN: verificación de DPI ────────────────────────────────────────────────

// GET /api/auth/admin/dpi-pendientes — lista asesores con DPI pendiente de verificación
router.get('/admin/dpi-pendientes', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const pendientes = db.prepare(`
      SELECT id, nombre, email, telefono, foto, dpi_archivo, dpi_subido_en, dpi_estado, dpi_rechazado_razon, plan, codigo_asesor, slug
      FROM usuarios
      WHERE dpi_archivo IS NOT NULL AND dpi_archivo != ''
      ORDER BY CASE WHEN dpi_estado IS NULL OR dpi_estado = 'pendiente' THEN 0 ELSE 1 END, dpi_subido_en DESC
    `).all();
    res.json(pendientes);
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// GET /api/auth/admin/dpi/:id/documento — sirve el documento solo a admins autenticados
router.get('/admin/dpi/:id/documento', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    if (decoded.rol !== 'admin') return res.status(403).json({ error: 'No autorizado' });

    const asesorId = parseInt(req.params.id);
    const row = db.prepare("SELECT dpi_archivo FROM usuarios WHERE id = ? AND dpi_archivo IS NOT NULL AND dpi_archivo != ''").get(asesorId);
    if (!row) return res.status(404).json({ error: 'Documento no encontrado' });

    const nombre = path.basename(row.dpi_archivo);
    const buscarEn = [dpiDir, dpiDirLegacy];
    const resolvedFile = buscarEn
      .map(dir => ({ dir: path.resolve(dir), file: path.resolve(path.join(dir, nombre)) }))
      .find(({ dir, file }) => file.startsWith(dir + path.sep) && fs.existsSync(file));
    if (!resolvedFile) return res.status(404).json({ error: 'Archivo no encontrado' });

    res.sendFile(resolvedFile.file);
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PATCH /api/auth/admin/asesores/:id/plus-one
router.patch('/admin/asesores/:id/plus-one', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const autorizado = req.body.autorizado ? 1 : 0;
    const notas = (req.body.notas || '').trim().slice(0, 500);
    db.prepare(`
      UPDATE usuarios
      SET puede_plus_one = ?,
          plus_one_aprobado_en = CASE WHEN ? = 1 THEN COALESCE(NULLIF(plus_one_aprobado_en, ''), datetime('now')) ELSE '' END,
          plus_one_notas = ?
      WHERE id = ? AND rol = 'asesor'
    `).run(autorizado, autorizado, notas, req.params.id);
    res.json({ ok: true, autorizado });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PATCH /api/auth/admin/dpi/:id/aprobar — aprueba el DPI de un asesor
router.patch('/admin/dpi/:id/aprobar', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const asesorId = parseInt(req.params.id);
    db.prepare("UPDATE usuarios SET dpi_estado='aprobado', dpi_rechazado_razon=NULL WHERE id=?").run(asesorId);
    res.json({ ok: true, mensaje: 'DPI aprobado' });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// PATCH /api/auth/admin/dpi/:id/rechazar — rechaza el DPI con una razón
router.patch('/admin/dpi/:id/rechazar', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'inmobia_secret_2024');
    const admin = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(decoded.id);
    if (!admin || admin.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });

    const asesorId = parseInt(req.params.id);
    const { razon } = req.body;
    if (!razon) return res.status(400).json({ error: 'Debe indicar la razón del rechazo' });
    db.prepare("UPDATE usuarios SET dpi_estado='rechazado', dpi_rechazado_razon=?, dpi_archivo=NULL, dpi_subido_en=NULL WHERE id=?")
      .run(razon, asesorId);
    res.json({ ok: true, mensaje: 'DPI rechazado' });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

export default router;
