import { Router } from 'express';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { crearTransporter } from '../email.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

function waLink(tel, texto) {
  const digits = String(tel || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(texto || '')}`;
}

function htmlRespuesta5RA({ autorNombre, respondedor, prop, req: r }) {
  const precio = (r.precio_min || r.precio_max) ? `${r.moneda || 'GTQ'} ${(r.precio_min||'?').toLocaleString?.()||r.precio_min||'?'} – ${(r.precio_max||'?').toLocaleString?.()||r.precio_max||'?'}` : '—';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
    <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:#1e2d4a;border-top:4px solid #c9a84c;padding:24px 32px">
        <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Red colaborativa · Modelo 5RA</p>
        <h1 style="margin:0;color:#fff;font-size:1.2rem">Un colega respondió a tu requerimiento</h1>
      </div>
      <div style="padding:24px 32px">
        <p style="margin:0 0 14px;color:#444">Hola <strong>${autorNombre || ''}</strong>, un asesor respondió con una propiedad que encaja con tu requerimiento para el cliente <strong>${r.cliente_nombre || 's/n'}</strong>.</p>
        <div style="border:2px solid #1e2d4a;border-radius:10px;padding:16px 18px;margin:16px 0">
          <h2 style="margin:0 0 6px;color:#1e2d4a;font-size:1.05rem">${prop.titulo || 'Propiedad'}</h2>
        </div>
        <div style="background:#fff7e3;border-left:3px solid #c9a84c;padding:12px 14px;border-radius:6px;font-size:0.82rem;color:#444;margin:16px 0">
          <p style="margin:0 0 6px;font-weight:600;color:#1e2d4a">Tu requerimiento</p>
          <p style="margin:0">${r.operacion} · ${r.tipo_propiedad} · ${[r.municipio, r.zona, r.colonia].filter(Boolean).join(' · ')}<br>${precio}</p>
        </div>
        <div style="background:#f0fdf4;border-left:3px solid #16a34a;padding:12px 14px;border-radius:6px;font-size:0.82rem;color:#444">
          <p style="margin:0 0 6px;font-weight:600;color:#065f46">Siguiente paso</p>
          <p style="margin:0">Ingresa a tu CRM para revisar el lead y aceptar el convenio de colaboración. Los datos de contacto del colega estarán disponibles una vez que ambos firmen el convenio.</p>
        </div>
        <div style="text-align:center;margin:22px 0 6px">
          <a href="${BASE_URL}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:7px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a>
        </div>
      </div>
      <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Notificación automática de respuesta a requerimiento</div>
    </div></body></html>`;
}

const router = Router();

// ── GET /api/requerimientos/admin/:id/leads  (admin — leads de un requerimiento)
router.get('/admin/:id/leads', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const leads = db.prepare(`
    SELECT l.*,
      uc.nombre AS captor_nombre, uc.email AS captor_email, uc.telefono AS captor_telefono, uc.codigo_asesor AS captor_codigo,
      ur.nombre AS referente_nombre, ur.email AS referente_email, ur.telefono AS referente_telefono, ur.codigo_asesor AS referente_codigo,
      p.titulo AS prop_titulo, p.precio AS prop_precio, p.moneda AS prop_moneda, p.tipo AS prop_tipo
    FROM leads l
    LEFT JOIN usuarios uc ON uc.id = l.asesor_id
    LEFT JOIN usuarios ur ON ur.id = l.asesor_referente_id
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE l.requerimiento_id = ?
    ORDER BY l.creado_en DESC
  `).all(req.params.id);
  res.json({ leads });
});

// ── PATCH /api/requerimientos/admin/:leadId/convenio  (admin edita convenio)
router.patch('/admin/:leadId/convenio', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { precio_estimado, comision_pct, moneda } = req.body;
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const pct = Math.max(1, Math.min(10, Number(comision_pct) || 5));
  db.prepare(`UPDATE leads SET convenio_precio_estimado = ?, convenio_comision_pct = ?, convenio_moneda = ? WHERE id = ?`)
    .run(Number(precio_estimado) || 0, pct, moneda === 'USD' ? 'USD' : 'GTQ', req.params.leadId);
  res.json({ ok: true });
});

// ── GET /api/requerimientos/admin/todos  (admin — vista global)
router.get('/admin/todos', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const hoy = new Date().toISOString();
  const filas = db.prepare(`
    SELECT r.*,
      u.nombre  AS asesor_nombre, u.email AS asesor_email, u.telefono AS asesor_telefono, u.codigo_asesor AS asesor_codigo, u.plan AS asesor_plan,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id) AS total_leads,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.etapa = 'cerrado') AS leads_cerrados,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL) AS leads_convenio_ambos,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND (l.convenio_captor_en IS NOT NULL OR l.convenio_referente_en IS NOT NULL)) AS leads_convenio_parcial,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.visita_coordinada_en IS NOT NULL) AS leads_con_visita,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.visita_realizada_en IS NOT NULL) AS leads_visita_hecha,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.papeleria_estado IS NOT NULL) AS leads_papeleria,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.contrato_fecha IS NOT NULL) AS leads_contrato,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.deposito_fecha IS NOT NULL) AS leads_pagos,
      (SELECT COUNT(*) FROM leads l WHERE l.requerimiento_id = r.id AND l.comision_pago_fecha IS NOT NULL) AS leads_comision
    FROM requerimientos r
    LEFT JOIN usuarios u ON u.id = r.asesor_id
    ORDER BY r.creado_en DESC
  `).all();
  res.json({ requerimientos: filas, total: filas.length });
});

const DURACION_DIAS = 3;
const vencimientoISO = (dias = DURACION_DIAS) => {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString();
};

// ── POST /api/requerimientos  (asesor Premium publica un requerimiento)
router.post('/', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT plan FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (u?.plan !== 'premium') return res.status(403).json({ error: 'Solo asesores Premium pueden publicar requerimientos' });

  const {
    cliente_nombre, cliente_telefono, cliente_email,
    operacion, tipo_propiedad, municipio, zona, colonia,
    precio_min, precio_max, moneda,
    habitaciones, banos, metros_min, caracteristicas, notas,
  } = req.body;

  if (!municipio || !tipo_propiedad || !operacion)
    return res.status(400).json({ error: 'municipio, tipo_propiedad y operacion son obligatorios' });

  const result = db.prepare(`
    INSERT INTO requerimientos (asesor_id, cliente_nombre, cliente_telefono, cliente_email,
      operacion, tipo_propiedad, municipio, zona, colonia,
      precio_min, precio_max, moneda,
      habitaciones, banos, metros_min, caracteristicas, notas, vence_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.usuario.id, cliente_nombre || null, cliente_telefono || null, cliente_email || null,
    operacion, tipo_propiedad,
    municipio || null, zona || null, colonia || null,
    precio_min ? Number(precio_min) : null,
    precio_max ? Number(precio_max) : null,
    moneda || 'GTQ',
    habitaciones ? Number(habitaciones) : null,
    banos ? Number(banos) : null,
    metros_min ? Number(metros_min) : null,
    caracteristicas || null, notas || null,
    vencimientoISO(),
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

// ── PUT /api/requerimientos/:id  (actualizar requerimiento propio)
router.put('/:id', authMiddleware, (req, res) => {
  const req_obj = db.prepare('SELECT asesor_id FROM requerimientos WHERE id = ?').get(req.params.id);
  if (!req_obj) return res.status(404).json({ error: 'Requerimiento no encontrado' });
  if (req_obj.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const {
    cliente_nombre, cliente_telefono, cliente_email,
    operacion, tipo_propiedad, municipio, zona, colonia,
    precio_min, precio_max, moneda,
    habitaciones, banos, metros_min, caracteristicas, notas,
  } = req.body;

  if (!municipio || !tipo_propiedad || !operacion)
    return res.status(400).json({ error: 'municipio, tipo_propiedad y operacion son obligatorios' });

  db.prepare(`
    UPDATE requerimientos SET
      cliente_nombre=?, cliente_telefono=?, cliente_email=?,
      operacion=?, tipo_propiedad=?, municipio=?, zona=?, colonia=?,
      precio_min=?, precio_max=?, moneda=?,
      habitaciones=?, banos=?, metros_min=?, caracteristicas=?, notas=?,
      actualizado_en = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    cliente_nombre || null, cliente_telefono || null, cliente_email || null,
    operacion, tipo_propiedad,
    municipio || null, zona || null, colonia || null,
    precio_min ? Number(precio_min) : null,
    precio_max ? Number(precio_max) : null,
    moneda || 'GTQ',
    habitaciones ? Number(habitaciones) : null,
    banos ? Number(banos) : null,
    metros_min ? Number(metros_min) : null,
    caracteristicas || null, notas || null,
    req.params.id
  );

  res.json({ ok: true });
});

// ── GET /api/requerimientos/mios  (mis requerimientos publicados)
router.get('/mios', authMiddleware, (req, res) => {
  const filas = db.prepare(`
    SELECT r.*, u.nombre AS asesor_nombre
    FROM requerimientos r
    LEFT JOIN usuarios u ON u.id = r.asesor_id
    WHERE r.asesor_id = ?
    ORDER BY r.creado_en DESC
  `).all(req.usuario.id);
  res.json({ requerimientos: filas });
});

// ── GET /api/requerimientos/activos  (red — todos los Premium ven requerimientos activos)
router.get('/activos', authMiddleware, (req, res) => {
  const hoy = new Date().toISOString();
  const filas = db.prepare(`
    SELECT
      r.id, r.fuente, r.estado, r.vence_en, r.creado_en, r.actualizado_en, r.renovaciones,
      r.tipo_propiedad, r.operacion, r.municipio, r.zona, r.colonia,
      r.precio_min, r.precio_max, r.moneda,
      r.habitaciones, r.banos, r.metros_min, r.caracteristicas, r.notas,
      r.cliente_nombre,
      -- email y teléfono del cliente nunca se exponen a otros asesores
      CASE WHEN r.fuente = 'cliente' THEN NULL ELSE r.cliente_email     END AS cliente_email,
      CASE WHEN r.fuente = 'cliente' THEN NULL ELSE r.cliente_telefono  END AS cliente_telefono,
      u.nombre AS asesor_nombre, u.slug AS asesor_slug, u.codigo_asesor AS asesor_codigo
    FROM requerimientos r
    LEFT JOIN usuarios u ON u.id = r.asesor_id
    WHERE r.estado = 'activo' AND r.vence_en > ? AND r.asesor_id != ?
    ORDER BY r.creado_en DESC
  `).all(hoy, req.usuario.id);
  res.json({ requerimientos: filas });
});

// ── POST /api/requerimientos/:id/responder  (Asesor B responde con una de sus propiedades)
router.post('/:id/responder', authMiddleware, (req, res) => {
  const { propiedad_id } = req.body;
  if (!propiedad_id) return res.status(400).json({ error: 'propiedad_id requerido' });

  const r = db.prepare('SELECT * FROM requerimientos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requerimiento no encontrado' });
  if (r.asesor_id === req.usuario.id) return res.status(400).json({ error: 'No puedes responder a tu propio requerimiento' });
  if (r.estado !== 'activo' || new Date(r.vence_en) < new Date())
    return res.status(400).json({ error: 'Este requerimiento ya no está activo' });

  const prop = db.prepare('SELECT id, titulo, usuario_id FROM propiedades WHERE id = ?').get(propiedad_id);
  if (!prop) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (prop.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'La propiedad no te pertenece' });

  // Evitar respuesta duplicada del mismo asesor con la misma propiedad
  const dup = db.prepare(`SELECT id FROM leads WHERE requerimiento_id = ? AND propiedad_id = ? AND asesor_id = ?`).get(r.id, prop.id, req.usuario.id);
  if (dup) return res.status(409).json({ error: 'Ya respondiste con esta propiedad', lead_id: dup.id });

  // Lead 5RA: captor = Asesor B (dueño de la propiedad, current user) · referente = Asesor A (autor del requerimiento, trae al cliente)
  const datosExtra = JSON.stringify({
    operacion: r.operacion, tipo_propiedad: r.tipo_propiedad,
    municipio: r.municipio, zona: r.zona, colonia: r.colonia,
    precio_min: r.precio_min, precio_max: r.precio_max, moneda: r.moneda,
    habitaciones: r.habitaciones, banos: r.banos, metros_min: r.metros_min,
    caracteristicas: r.caracteristicas, notas: r.notas,
  });

  const result = db.prepare(`
    INSERT INTO leads (asesor_id, nombre, email, telefono, mensaje, tipo, propiedad_id, propiedad_titulo, origen, etapa, datos_extra, asesor_referente_id, modelo, requerimiento_id)
    VALUES (?, ?, ?, ?, ?, 'red', ?, ?, 'red-5ra', 'nuevo', ?, ?, '5RA', ?)
  `).run(
    req.usuario.id,
    r.cliente_nombre || null,
    r.cliente_email || null,
    r.cliente_telefono || null,
    r.notas || null,
    prop.id,
    prop.titulo || null,
    datosExtra,
    r.asesor_id,
    r.id
  );

  // Notificar por email al autor del requerimiento (Asesor A)
  (async () => {
    try {
      const autor = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(r.asesor_id);
      const respondedor = db.prepare('SELECT nombre, email, telefono, slug, codigo_asesor FROM usuarios WHERE id = ?').get(req.usuario.id);
      if (autor?.email) {
        const transporter = crearTransporter();
        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: autor.email,
          subject: `🤝 Respuesta a tu requerimiento — ${respondedor?.nombre || 'Un asesor'} ofrece una propiedad`,
          html: htmlRespuesta5RA({ autorNombre: autor.nombre, respondedor, prop, req: r }),
        });
      }
    } catch (err) { console.error('Error notificando 5RA al autor:', err.message); }
  })();

  res.status(201).json({ ok: true, lead_id: result.lastInsertRowid });
});

// ── PATCH /api/requerimientos/:id/renovar
router.patch('/:id/renovar', authMiddleware, (req, res) => {
  const r = db.prepare('SELECT asesor_id FROM requerimientos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requerimiento no encontrado' });
  if (r.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const dias = Number(req.body?.dias) || DURACION_DIAS;
  db.prepare(`UPDATE requerimientos SET vence_en = ?, estado = 'activo', renovaciones = renovaciones + 1, actualizado_en = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(vencimientoISO(dias), req.params.id);
  res.json({ ok: true });
});

// ── PATCH /api/requerimientos/:id/cerrar  (cerrar manualmente)
router.patch('/:id/cerrar', authMiddleware, (req, res) => {
  const r = db.prepare('SELECT asesor_id FROM requerimientos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requerimiento no encontrado' });
  if (r.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  db.prepare(`UPDATE requerimientos SET estado = 'cerrado', actualizado_en = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.params.id);
  res.json({ ok: true });
});

// ── DELETE /api/requerimientos/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const r = db.prepare('SELECT asesor_id FROM requerimientos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requerimiento no encontrado' });
  if (r.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  db.prepare('DELETE FROM requerimientos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── GET /api/requerimientos/:id  (detalle)
router.get('/:id', authMiddleware, (req, res) => {
  const r = db.prepare(`
    SELECT r.*, u.nombre AS asesor_nombre, u.telefono AS asesor_telefono, u.email AS asesor_email, u.slug AS asesor_slug
    FROM requerimientos r LEFT JOIN usuarios u ON u.id = r.asesor_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrado' });
  res.json({ requerimiento: r });
});

export default router;
