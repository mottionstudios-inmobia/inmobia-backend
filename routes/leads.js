import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { splitComision, MODELOS, propiedadEsDeAdmin } from '../lib/modelos.js';
import { enviarCorreoVerificacionCierre, enviarCorreoPagoProgramado1D, enviarCorreoVisitaConfirmada5RA, enviarCorreoSolicitarCalificacion } from '../email.js';
import { sendWhatsApp } from '../whatsapp.js';

const router = Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

function sumarScore(asesorId, delta) {
  db.prepare('UPDATE usuarios SET score = MIN(5.0, MAX(1.0, ROUND(score + ?, 2))) WHERE id = ?').run(delta, asesorId);
  return db.prepare('SELECT score FROM usuarios WHERE id = ?').get(asesorId)?.score ?? 3.0;
}

// ── PATCH /api/leads/admin/:id/etapa-inmobia  (admin — mueve etapa del lead)
router.patch('/admin/:id/etapa-inmobia', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { etapa, nota_inmobia } = req.body;
  const etapasValidas = ['nuevo','agendado','visita-realizada','interesado','negociando','cerrado','inactivo','perdido'];
  if (etapa && !etapasValidas.includes(etapa))
    return res.status(400).json({ error: 'Etapa inválida' });

  const sets = [];
  const params = [];
  if (etapa       !== undefined) { sets.push('etapa = ?');        params.push(etapa); }
  if (nota_inmobia !== undefined) { sets.push('nota_inmobia = ?'); params.push(nota_inmobia); }
  if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
  params.push(Number(req.params.id));

  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ── GET /api/leads/admin/todos  (admin — todos los leads de todos los asesores)
router.get('/admin/todos', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });

  const { origen, etapa, asesor_id } = req.query;
  let sql = `
    SELECT l.*,
      u.nombre  AS asesor_nombre,  u.email AS asesor_email, u.plan AS asesor_plan,
      u.telefono AS asesor_telefono, u.slug AS asesor_slug,
      p.titulo   AS prop_titulo,    p.tipo  AS prop_tipo,
      p.operacion AS prop_operacion, p.precio AS prop_precio, p.moneda AS prop_moneda,
      p.zona AS prop_zona, p.codigo AS prop_codigo,
      p.habitaciones AS prop_habitaciones, p.banos AS prop_banos,
      p.parqueos AS prop_parqueos, p.metros AS prop_metros,
      ur.nombre  AS partner_nombre,  ur.slug AS partner_slug,
      CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL
           THEN ur.telefono ELSE NULL END AS partner_telefono,
      CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL
           THEN ur.email ELSE NULL END AS partner_email,
      c.estrellas   AS calificacion_estrellas,
      c.razones     AS calificacion_razones,
      c.comentario  AS calificacion_comentario,
      c.creado_en   AS calificacion_en
    FROM leads l
    LEFT JOIN usuarios u  ON u.id  = l.asesor_id
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    LEFT JOIN usuarios ur   ON ur.id = l.asesor_referente_id
    LEFT JOIN calificaciones c ON c.lead_id = l.id
    WHERE 1=1
  `;
  const params = [];
  if (origen)    { sql += ' AND l.origen = ?';    params.push(origen); }
  if (etapa)     { sql += ' AND l.etapa = ?';     params.push(etapa); }
  if (asesor_id) { sql += ' AND l.asesor_id = ?'; params.push(Number(asesor_id)); }
  sql += ' ORDER BY l.creado_en DESC';

  const leads = db.prepare(sql).all(...params);
  res.json({ leads, total: leads.length });
});

const LEADS_SELECT = `
  SELECT l.*,
    p.codigo  AS prop_codigo,  p.zona      AS prop_zona,
    p.tipo    AS prop_tipo,    p.operacion AS prop_operacion,
    p.precio  AS prop_precio,  p.moneda    AS prop_moneda,
    p.habitaciones AS prop_habitaciones, p.banos AS prop_banos,
    p.parqueos AS prop_parqueos, p.metros AS prop_metros,
    p.nombre_proyecto AS prop_proyecto,
    (SELECT url FROM imagenes WHERE propiedad_id = l.propiedad_id AND principal = 1 LIMIT 1) AS prop_imagen,
    ur.nombre AS partner_nombre,
    CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL THEN ur.telefono ELSE NULL END AS partner_telefono,
    CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL THEN ur.email ELSE NULL END AS partner_email,
    ur.slug AS partner_slug,
    ur.codigo_asesor AS partner_codigo,
    l.convenio_moneda AS convenio_moneda,
    c.estrellas    AS calificacion_estrellas,
    c.razones      AS calificacion_razones,
    c.comentario   AS calificacion_comentario,
    c.creado_en    AS calificacion_en,
    l.papeleria_fecha, l.papeleria_estado, l.papeleria_comentario,
    l.contrato_fecha,
    l.deposito_fecha, l.deposito_monto, l.deposito_comprobante,
    l.primera_renta_fecha, l.primera_renta_monto, l.primera_renta_comprobante,
    l.comision_pago_fecha, l.comision_pago_tipo, l.comision_comprobante
  FROM leads l
  LEFT JOIN propiedades p ON p.id = l.propiedad_id
  LEFT JOIN usuarios ur ON ur.id = l.asesor_referente_id
  LEFT JOIN calificaciones c ON c.lead_id = l.id
  WHERE l.asesor_id = ?
`;

// ── GET /api/leads  (asesor autenticado — todos sus leads)
router.get('/', authMiddleware, (req, res) => {
  const leads = db.prepare(LEADS_SELECT + ' ORDER BY l.creado_en DESC').all(req.usuario.id);
  res.json({ leads });
});

// ── GET /api/leads/compartidos  (leads tripartitos donde el asesor es referente — vista espejo)
const LEADS_COMPARTIDOS_SELECT = `
  SELECT l.*,
    p.codigo  AS prop_codigo,  p.zona      AS prop_zona,
    p.tipo    AS prop_tipo,    p.operacion AS prop_operacion,
    p.precio  AS prop_precio,  p.moneda    AS prop_moneda,
    p.habitaciones AS prop_habitaciones, p.banos AS prop_banos,
    p.parqueos AS prop_parqueos, p.metros AS prop_metros,
    (SELECT i.url FROM imagenes i WHERE i.propiedad_id = l.propiedad_id ORDER BY i.principal DESC, i.orden ASC LIMIT 1) AS prop_foto,
    uc.nombre AS partner_nombre,
    CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL THEN uc.telefono ELSE NULL END AS partner_telefono,
    CASE WHEN l.convenio_captor_en IS NOT NULL AND l.convenio_referente_en IS NOT NULL THEN uc.email ELSE NULL END AS partner_email,
    uc.slug AS partner_slug,
    uc.codigo_asesor AS partner_codigo
  FROM leads l
  LEFT JOIN propiedades p ON p.id = l.propiedad_id
  LEFT JOIN usuarios uc ON uc.id = l.asesor_id
  WHERE l.asesor_referente_id = ? AND l.origen IN ('tripartito','red-5ra')
  ORDER BY l.creado_en DESC
`;
router.get('/compartidos', authMiddleware, (req, res) => {
  const leads = db.prepare(LEADS_COMPARTIDOS_SELECT).all(req.usuario.id);
  res.json({ leads });
});

// ── POST /api/leads/proponer-4t  (captor propone compartir su propiedad con un referente)
router.post('/proponer-4t', authMiddleware, (req, res) => {
  const { propiedad_id, referente_id, mensaje } = req.body;
  if (!propiedad_id || !referente_id) return res.status(400).json({ error: 'propiedad_id y referente_id son requeridos' });

  const prop = db.prepare('SELECT id, titulo, usuario_id FROM propiedades WHERE id = ?').get(propiedad_id);
  if (!prop) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (prop.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'La propiedad no te pertenece' });

  const referente = db.prepare('SELECT id, nombre, email, rol FROM usuarios WHERE id = ? AND rol = ?').get(referente_id, 'asesor');
  if (!referente) return res.status(404).json({ error: 'Asesor referente no encontrado' });
  if (referente.id === req.usuario.id) return res.status(400).json({ error: 'No puedes compartir contigo mismo' });

  // Evitar duplicado activo
  const dup = db.prepare(`SELECT id FROM leads WHERE propiedad_id = ? AND asesor_id = ? AND asesor_referente_id = ? AND modelo = '4T' AND etapa NOT IN ('cerrado','no_interesado')`).get(propiedad_id, req.usuario.id, referente_id);
  if (dup) return res.status(409).json({ error: 'Ya tienes una propuesta activa con este asesor para esta propiedad', lead_id: dup.id });

  const result = db.prepare(`
    INSERT INTO leads (asesor_id, asesor_referente_id, propiedad_id, propiedad_titulo, modelo, origen, etapa, mensaje, tipo)
    VALUES (?, ?, ?, ?, '4T', 'tripartito', 'agendado', ?, 'mensaje')
  `).run(req.usuario.id, referente.id, prop.id, prop.titulo, mensaje || null);

  res.json({ ok: true, lead_id: result.lastInsertRowid });
});

// ── PATCH /api/leads/:id/visita-realizada  (asesor marca visita como realizada)
router.patch('/:id/visita-realizada', authMiddleware, (req, res) => {
  const { realizada } = req.body;
  const lead = db.prepare('SELECT asesor_id, asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id && lead.asesor_referente_id !== req.usuario.id)
    return res.status(403).json({ error: 'Sin permiso' });
  const valor = realizada ? new Date().toISOString().slice(0,19).replace('T',' ') : null;
  if (realizada) {
    db.prepare('UPDATE leads SET visita_realizada_en = ?, etapa = ? WHERE id = ?').run(valor, 'visita-realizada', req.params.id);
  } else {
    const current = db.prepare('SELECT etapa FROM leads WHERE id = ?').get(req.params.id);
    const nuevaEtapa = current?.etapa === 'visita-realizada' ? 'agendado' : current?.etapa;
    db.prepare('UPDATE leads SET visita_realizada_en = NULL, etapa = ? WHERE id = ?').run(nuevaEtapa, req.params.id);
  }
  res.json({ ok: true, visita_realizada_en: valor });
});

// ── PATCH /api/leads/:id/convenio-2a  (asesor acepta el convenio del modelo 2A)
router.patch('/:id/convenio-2a', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (lead.modelo !== '2A' && lead.origen !== 'inmobia') return res.status(400).json({ error: 'Solo aplica al modelo 2A' });
  if (lead.convenio_captor_en) return res.status(400).json({ error: 'Convenio ya firmado' });

  const ahora = new Date().toISOString();
  db.prepare(`UPDATE leads SET convenio_captor_en = ?, etapa = 'agendado' WHERE id = ?`).run(ahora, lead.id);
  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'sistema', ?)`)
    .run(lead.id, req.usuario.id, '✅ Convenio de intermediación 2A firmado. Listo para coordinar la visita.');

  res.json({ ok: true, convenio_en: ahora });
});

// ── POST /api/leads/:id/mensaje-cliente-2a  (asesor envía mensaje al cliente vía InmobIA WhatsApp)
router.post('/:id/mensaje-cliente-2a', authMiddleware, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (lead.modelo !== '2A' && lead.origen !== 'inmobia') return res.status(400).json({ error: 'Solo aplica al modelo 2A' });
  if (!lead.convenio_captor_en) return res.status(400).json({ error: 'Firme el convenio primero' });

  const asesor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
  const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];

  if (lead.telefono) {
    const token2 = crypto.randomBytes(32).toString('hex');
    const expira2 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
      .run(token2, (lead.email || '').toLowerCase().trim(), lead.id, expira2);
    const linkPanel2 = `${BASE_URL}/panel-cliente.html?token=${token2}`;
    const msgWA =
`*Mensaje de InmobIA para ${primerNombre}*

Su asesor de InmobIA le envía el siguiente mensaje sobre su visita:

_"${mensaje.trim()}"_

Puede responder directamente a este mensaje o ingresar a su panel personal:
${linkPanel2}`;
    sendWhatsApp(lead.telefono, msgWA, lead.id).catch(e => console.error('[WA msg 2A]', e.message));
  }

  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'wa-saliente', ?)`)
    .run(lead.id, req.usuario.id, mensaje.trim());

  res.json({ ok: true });
});

// ── GET /api/leads/:id/chat-2a  (historial de mensajes WA del lead)
router.get('/:id/chat-2a', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const mensajes = db.prepare(`
    SELECT id, tipo, nota, creado_en
    FROM lead_bitacora
    WHERE lead_id = ? AND tipo IN ('wa-saliente','wa-entrante')
    ORDER BY creado_en ASC
  `).all(req.params.id);
  res.json({ mensajes });
});

// ── POST /api/leads/:id/mensaje-cliente-paso3  (asesor envía mensaje post-visita)
router.post('/:id/mensaje-cliente-paso3', authMiddleware, async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (lead.modelo !== '2A' && lead.origen !== 'inmobia') return res.status(400).json({ error: 'Solo aplica al modelo 2A' });
  if (!lead.visita_coordinada_en) return res.status(400).json({ error: 'Visita no coordinada' });

  if (lead.telefono) {
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
      .run(token, (lead.email || '').toLowerCase().trim(), lead.id, expira);
    const linkPanel = `${BASE_URL}/panel-cliente.html?token=${token}`;
    const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];
    const msgWA =
`*Seguimiento InmobIA para ${primerNombre}*

Tu asesor te envía un mensaje sobre tu visita:

_"${mensaje.trim()}"_

Puedes responder aquí o ingresar a tu panel:
${linkPanel}`;
    sendWhatsApp(lead.telefono, msgWA, lead.id).catch(e => console.error('[WA paso3]', e.message));
  }

  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'wa-paso3-saliente', ?)`)
    .run(lead.id, req.usuario.id, mensaje.trim());

  res.json({ ok: true });
});

// ── GET /api/leads/:id/chat-paso3  (historial post-visita del lead)
router.get('/:id/chat-paso3', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const mensajes = db.prepare(`
    SELECT id, tipo, nota, creado_en
    FROM lead_bitacora
    WHERE lead_id = ? AND tipo LIKE 'wa-paso3%'
    ORDER BY creado_en ASC
  `).all(req.params.id);
  res.json({ mensajes });
});

// ── PATCH /api/leads/:id/confirmar-visita-realizada  (asesor confirma visita realizada)
router.patch('/:id/confirmar-visita-realizada', authMiddleware, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (lead.modelo !== '2A' && lead.origen !== 'inmobia') return res.status(400).json({ error: 'Solo aplica al modelo 2A' });
  if (!lead.visita_coordinada_en) return res.status(400).json({ error: 'Visita no coordinada' });
  if (!lead.visita_cliente_confirmada_en) return res.status(409).json({ error: 'El cliente aún no ha confirmado su asistencia a la visita' });

  db.prepare('UPDATE leads SET visita_realizada_en = CURRENT_TIMESTAMP, etapa = ? WHERE id = ?').run('visita-realizada', lead.id);
  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'visita-confirmada', ?)`)
    .run(lead.id, req.usuario.id, 'Visita realizada - confirmado por asesor');

  // Enviar encuesta automática al cliente por WhatsApp
  if (lead.telefono) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
        .run(token, (lead.email || '').toLowerCase().trim(), lead.id, expira);
      const linkEncuesta = `${BASE_URL}/panel-cliente.html?token=${token}&encuesta=1`;
      const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];
      const msgEncuesta =
`Hola *${primerNombre}* 👋, soy InmobIA.

Sabemos que ya realizaste tu visita a la propiedad. ¡Gracias por tu tiempo!

Nos gustaría conocer tu opinión para ayudarte mejor:

🔗 *Responde aquí (solo toma 1 minuto):*
${linkEncuesta}

Tu opinión es importante para encontrar la propiedad ideal para ti. 🏠`;

      await sendWhatsApp(lead.telefono, msgEncuesta, lead.id);
      db.prepare('UPDATE leads SET encuesta_enviada_en = CURRENT_TIMESTAMP WHERE id = ?').run(lead.id);
      db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'encuesta-enviada', ?)`)
        .run(lead.id, req.usuario.id, 'Encuesta post-visita enviada al cliente por WhatsApp');
    } catch (e) {
      console.error('[encuesta]', e.message);
    }
  }

  res.json({ ok: true });
});

// ── POST /api/leads/:id/encuesta-visita  (cliente responde encuesta — ruta pública con magic link)
router.post('/:id/encuesta-visita', async (req, res) => {
  const { token, estrellas, interes, razones, comentario } = req.body;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  const magicLink = db.prepare('SELECT * FROM magic_links WHERE token = ? AND expira_en > datetime("now")').get(token);
  if (!magicLink || magicLink.lead_id !== Number(req.params.id))
    return res.status(403).json({ error: 'Token inválido o expirado' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });

  db.prepare(`UPDATE leads SET
    encuesta_respondida_en = CURRENT_TIMESTAMP,
    encuesta_estrellas = ?,
    encuesta_interes = ?,
    encuesta_razones = ?,
    encuesta_comentario = ?
    WHERE id = ?`).run(
    estrellas || null,
    interes || null,
    razones ? JSON.stringify(razones) : null,
    comentario || null,
    lead.id
  );

  const resumen =
    `⭐ ${estrellas || '?'}/5 · ${interes || ''}\n` +
    (razones?.length ? `Razones: ${razones.join(', ')}\n` : '') +
    (comentario ? `"${comentario}"` : '');

  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'encuesta-respondida', ?)`)
    .run(lead.id, lead.asesor_id, resumen);

  // Si el cliente indica no-interesado → mover lead a inactivo
  if (interes === 'no-interesado') {
    db.prepare(`UPDATE leads SET etapa = 'inactivo' WHERE id = ?`).run(lead.id);
    db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'auto-etapa', ?)`)
      .run(lead.id, lead.asesor_id, 'Cliente indicó no estar interesado en la propiedad — lead movido a Inactivo');
  }

  res.json({ ok: true });
});

// ── PATCH /api/leads/:id/opinion-asesor  (asesor registra su opinión post-visita)
router.patch('/:id/opinion-asesor', authMiddleware, (req, res) => {
  const { interes, comentario, fecha_seguimiento } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (!lead.visita_realizada_en) return res.status(409).json({ error: 'La visita aún no fue confirmada' });

  const opcionesValidas = ['no-interesado', 'no-seguro', 'lo-pensara', 'interesado', 'muy-interesado'];
  if (!opcionesValidas.includes(interes)) return res.status(400).json({ error: 'Nivel de interés inválido' });

  const nuevaEtapa = ['interesado', 'muy-interesado'].includes(interes) ? 'interesado' : lead.etapa;

  db.prepare(`UPDATE leads SET
    asesor_interes = ?, asesor_interes_comentario = ?,
    asesor_fecha_seguimiento = ?, asesor_interes_en = CURRENT_TIMESTAMP,
    etapa = ?
    WHERE id = ?`).run(interes, comentario || null, fecha_seguimiento || null, nuevaEtapa, lead.id);

  const labelInteres = { 'no-interesado':'No interesad@','no-seguro':'No está segur@','lo-pensara':'Lo pensará','interesado':'Interesad@','muy-interesado':'Muy interesad@' };
  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'opinion-asesor', ?)`)
    .run(lead.id, req.usuario.id, `Opinión del asesor: ${labelInteres[interes]}${comentario ? ` — "${comentario}"` : ''}`);

  res.json({ ok: true, etapa: nuevaEtapa });
});

// ── POST /api/leads/:id/mensaje-seguimiento  (asesor envía mensaje de seguimiento)
router.post('/:id/mensaje-seguimiento', authMiddleware, async (req, res) => {
  const { texto } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (!texto?.trim()) return res.status(400).json({ error: 'Texto requerido' });

  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'seguimiento-saliente', ?)`)
    .run(lead.id, req.usuario.id, texto.trim().slice(0, 1000));

  await sendWhatsApp(lead.telefono, texto.trim(), lead.id);
  res.json({ ok: true });
});

// ── GET /api/leads/:id/chat-seguimiento  (mensajes del chat de seguimiento)
router.get('/:id/chat-seguimiento', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead || lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const msgs = db.prepare(`SELECT tipo, nota, creado_en FROM lead_bitacora
    WHERE lead_id = ? AND tipo IN ('seguimiento-saliente','wa-entrante')
    ORDER BY creado_en ASC LIMIT 60`).all(req.params.id);
  res.json({ msgs });
});

// ── GET /api/leads/:id/encuesta-visita  (obtener respuesta de encuesta — para panel cliente y asesor)
router.get('/:id/encuesta-visita', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  const magicLink = db.prepare('SELECT * FROM magic_links WHERE token = ? AND expira_en > datetime("now")').get(token);
  if (!magicLink || magicLink.lead_id !== Number(req.params.id))
    return res.status(403).json({ error: 'Token inválido o expirado' });

  const lead = db.prepare(`SELECT encuesta_enviada_en, encuesta_respondida_en,
    encuesta_estrellas, encuesta_interes, encuesta_razones, encuesta_comentario
    FROM leads WHERE id = ?`).get(req.params.id);

  res.json({ encuesta: lead });
});

// ── PATCH /api/leads/:id/visita-coordinada  (captor o referente pueden fijar la fecha/hora acordada)
router.patch('/:id/visita-coordinada', authMiddleware, async (req, res) => {
  const { fecha } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id && lead.asesor_referente_id !== req.usuario.id)
    return res.status(403).json({ error: 'Sin permiso' });
  const esColab = lead.modelo === '4T' || lead.modelo === '5RA';
  if (esColab && fecha && (!lead.convenio_captor_en || !lead.convenio_referente_en))
    return res.status(400).json({ error: 'Ambos asesores deben firmar el convenio antes de agendar la visita' });
  if (fecha) {
    db.prepare(`UPDATE leads SET visita_coordinada_en = ?, etapa = 'agendado' WHERE id = ?`).run(fecha, req.params.id);
    // WhatsApp al cliente — solo modelo 2A (InmobIA intermediario)
    if (lead.modelo === '2A' && lead.telefono) {
      const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];
      const fechaLegible = new Date(fecha).toLocaleString('es-GT', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
        timeZone: 'America/Guatemala',
      });
      const tokenV = crypto.randomBytes(32).toString('hex');
      const expiraV = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
        .run(tokenV, (lead.email || '').toLowerCase().trim(), lead.id, expiraV);
      const linkPanelV = `${BASE_URL}/panel-cliente.html?token=${tokenV}`;
      const msg =
`*¡Hola ${primerNombre}!* 🏠

Su visita ha sido confirmada para:
📅 *${fechaLegible}*

Por favor, llegue puntualmente. Si necesita reagendar, avísenos con anticipación respondiendo este mensaje.

Puede revisar los detalles en su panel personal de InmobIA:
${linkPanelV}`;
      sendWhatsApp(lead.telefono, msg, lead.id).catch(e => console.error('[WA visita 2A]', e.message));
    }
  } else {
    // Reagendar: limpiar fecha y volver a "nuevo" para que quede pendiente de agendar
    db.prepare(`UPDATE leads SET visita_coordinada_en = NULL, etapa = 'nuevo' WHERE id = ?`).run(req.params.id);
  }
  res.json({ ok: true });
});

// ── POST /api/leads/:id/convenio/firmar  (captor define precio y moneda; comisión negociable; ambos firman)
router.post('/:id/convenio/firmar', authMiddleware, (req, res) => {
  const { precio_estimado, moneda, comision_pct, mensaje } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const esColab = lead.modelo === '4T' || lead.modelo === '5RA';
  if (!esColab) return res.status(400).json({ error: 'Este lead no requiere convenio' });

  const esCaptor = lead.asesor_id === req.usuario.id;
  const esReferente = lead.asesor_referente_id === req.usuario.id;
  if (!esCaptor && !esReferente) return res.status(403).json({ error: 'Sin permiso' });

  const ahora = new Date().toISOString();
  if (esCaptor) {
    const precio = Number(precio_estimado) || 0;
    if (!precio || precio <= 0) return res.status(400).json({ error: 'Ingrese el precio estimado del cierre.' });
    const monedaVal = moneda === 'USD' ? 'USD' : 'GTQ';
    const pct = Math.max(1, Math.min(10, Number(comision_pct) || 5));
    db.prepare('UPDATE leads SET convenio_captor_en = ?, convenio_comision_pct = ?, convenio_precio_estimado = ?, convenio_moneda = ?, convenio_mensaje = ?, convenio_rechazado_por = NULL, convenio_rechazado_nota = NULL, convenio_rechazado_en = NULL WHERE id = ?')
      .run(ahora, pct, precio, monedaVal, mensaje || null, req.params.id);

    // Notificar al referente para que firme su parte
    (async () => {
      try {
        const referente = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_referente_id);
        const captor    = db.prepare('SELECT nombre, codigo_asesor FROM usuarios WHERE id = ?').get(req.usuario.id);
        const monedaSym = monedaVal === 'USD' ? '$' : 'Q';
        const precioFmt = `${monedaSym}${Number(precio).toLocaleString('es-GT')}`;
        if (referente?.email) {
          const { crearTransporter } = await import('../email.js');
          const transporter = crearTransporter();
          await transporter.sendMail({
            from: `"InmobIA" <${process.env.SMTP_USER}>`,
            to: referente.email,
            subject: `⚡ Acción requerida: firma el convenio para activar la colaboración`,
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
              <div style="max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:#1e2d4a;border-top:4px solid #f59e0b;padding:22px 32px">
                  <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">⚡ Acción urgente · Red colaborativa</p>
                  <h1 style="margin:0;color:#fff;font-size:1.15rem">Tu colega firmó el convenio — ahora te toca a ti</h1>
                </div>
                <div style="padding:24px 32px">
                  <p style="margin:0 0 16px;color:#444">Hola <strong>${referente.nombre || ''}</strong>, el asesor <strong>${captor?.nombre || 'tu colega'}</strong> ya aceptó los términos del convenio de colaboración para el lead de tu cliente <strong>${lead.nombre || 'sin nombre'}</strong>.</p>
                  <div style="background:#fffbef;border:2px solid #f59e0b;border-radius:8px;padding:14px 16px;margin:16px 0">
                    <p style="margin:0 0 6px;font-weight:700;color:#92400e;font-size:0.88rem">Términos del convenio</p>
                    <p style="margin:0;font-size:0.85rem;color:#444">Precio estimado del cierre: <strong>${precioFmt}</strong><br>Comisión InmobIA: <strong>5% a cada asesor</strong><br>Tu participación: <strong>45% de la comisión bruta</strong></p>
                  </div>
                  <div style="background:#f0fdf4;border-left:3px solid #16a34a;padding:12px 14px;border-radius:6px;font-size:0.84rem;color:#444;margin:16px 0">
                    <p style="margin:0 0 4px;font-weight:700;color:#065f46">¿Qué sigue?</p>
                    <p style="margin:0">Ingresa a tu CRM, abre este lead y firma el convenio. Una vez que ambos firmen, podrán coordinar la visita y avanzar al cierre.</p>
                  </div>
                  <div style="text-align:center;margin:22px 0 6px">
                    <a href="${BASE_URL}/panel-asesor.html#crm" style="display:inline-block;background:#f59e0b;color:#1e2d4a;text-decoration:none;padding:12px 28px;border-radius:7px;font-weight:700;font-size:0.9rem">Firmar el convenio ahora →</a>
                  </div>
                </div>
                <div style="background:#f4f6fb;padding:12px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Notificación de convenio colaborativo pendiente</div>
              </div></body></html>`,
          });
        }
      } catch (err) { console.error('Error notificando firma de convenio al referente:', err.message); }
    })();
  } else {
    if (!lead.convenio_captor_en) return res.status(400).json({ error: 'El captor debe firmar primero' });
    // Marcar que el referente firmó Y que el convenio está completamente aceptado
    db.prepare('UPDATE leads SET convenio_referente_en = ?, convenio_aceptado_en = ? WHERE id = ?')
      .run(ahora, ahora, req.params.id);
  }
  res.json({ ok: true });
});

// ── POST /api/leads/:id/agendamiento-nota  (guardar nota sobre agendamiento de visita)
router.post('/:id/agendamiento-nota', authMiddleware, (req, res) => {
  const { nota } = req.body;
  const lead = db.prepare('SELECT asesor_id, asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id && lead.asesor_referente_id !== req.usuario.id)
    return res.status(403).json({ error: 'Sin permiso' });

  db.prepare('UPDATE leads SET agendamiento_nota = ? WHERE id = ?')
    .run(nota?.trim() || null, req.params.id);

  res.json({ ok: true });
});

// ── POST /api/leads/:id/convenio/rechazar  (referente rechaza — resetea convenio y notifica al captor)
router.post('/:id/convenio/rechazar', authMiddleware, (req, res) => {
  const { razon } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_referente_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (!lead.convenio_captor_en) return res.status(400).json({ error: 'No hay convenio pendiente de firma' });

  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET convenio_captor_en = NULL, convenio_comision_pct = NULL, convenio_precio_estimado = NULL, convenio_moneda = NULL, convenio_rechazado_por = ?, convenio_rechazado_nota = ?, convenio_rechazado_en = ? WHERE id = ?')
    .run('referente', razon || null, ahora, req.params.id);

  // Agregar a bitácora para que el captor vea la razón en el CRM
  const referenteData = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
  const notaBitacora = `⚠ Convenio rechazado por ${referenteData?.nombre || 'el referente'}${razon ? ` — "${razon}"` : ''}`;
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', notaBitacora);

  (async () => {
    try {
      const captor = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_id);
      const referente = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
      if (captor?.email) {
        const { crearTransporter } = await import('../email.js');
        const transporter = crearTransporter();
        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: captor.email,
          subject: `⚠️ Convenio rechazado por ${referente?.nombre || 'el referente'}`,
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
            <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
              <div style="background:#1e2d4a;border-top:4px solid #ef4444;padding:22px 32px">
                <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Red colaborativa · Convenio rechazado</p>
                <h1 style="margin:0;color:#fff;font-size:1.15rem">El asesor referente no aceptó el convenio</h1>
              </div>
              <div style="padding:24px 32px">
                <p style="margin:0 0 14px;color:#444">Hola <strong>${captor.nombre || ''}</strong>, <strong>${referente?.nombre || 'el referente'}</strong> revisó los términos del convenio para el lead colaborativo y no los aceptó.</p>
                ${razon ? `
                <div style="background:#fef2f2;border-left:3px solid #ef4444;padding:12px 16px;border-radius:6px;font-size:0.88rem;color:#444;margin-bottom:18px">
                  <p style="margin:0 0 6px;font-weight:700;color:#991b1b">Razón indicada por el referente:</p>
                  <p style="margin:0;line-height:1.5">${razon}</p>
                </div>` : ''}
                <p style="font-size:0.85rem;color:#6b7a99">El convenio fue reiniciado. Puede ingresar a su CRM para revisar los términos y proponer un nuevo precio si lo considera necesario.</p>
                <div style="text-align:center;margin:20px 0 6px">
                  <a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a>
                </div>
              </div>
              <div style="background:#f4f6fb;padding:12px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Notificación de rechazo de convenio colaborativo</div>
            </div></body></html>`,
        });
      }
    } catch (err) { console.error('Error notificando rechazo de convenio:', err.message); }
  })();

  res.json({ ok: true });
});

// ── POST /api/leads/:id/convenio/rechazar-captor  (captor rechaza el match — notifica al referente)
router.post('/:id/convenio/rechazar-captor', authMiddleware, (req, res) => {
  const { razon } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const esColab = lead.modelo === '4T' || lead.modelo === '5RA';
  if (!esColab) return res.status(400).json({ error: 'Este lead no es colaborativo' });

  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET convenio_captor_en = NULL, convenio_comision_pct = NULL, convenio_precio_estimado = NULL, convenio_moneda = NULL, convenio_rechazado_por = ?, convenio_rechazado_nota = ?, convenio_rechazado_en = ? WHERE id = ?')
    .run('captor', razon || null, ahora, req.params.id);

  const captorData = db.prepare('SELECT nombre, id FROM usuarios WHERE id = ?').get(req.usuario.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `⚠ Colaboración rechazada por ${captorData?.nombre || 'el captor'}${razon ? ` — "${razon}"` : ''}`);

  (async () => {
    try {
      const referente = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_referente_id);
      const captor    = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
      if (referente?.email) {
        const { crearTransporter } = await import('../email.js');
        const transporter = crearTransporter();
        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: referente.email,
          subject: `⚠️ Colaboración rechazada por ${captor?.nombre || 'el captor'}`,
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
            <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
              <div style="background:#1e2d4a;border-top:4px solid #ef4444;padding:22px 32px">
                <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Red colaborativa · Colaboración rechazada</p>
                <h1 style="margin:0;color:#fff;font-size:1.15rem">El asesor captor no aceptó la colaboración</h1>
              </div>
              <div style="padding:24px 32px">
                <p style="margin:0 0 14px;color:#444">Hola <strong>${referente.nombre || ''}</strong>, <strong>${captor?.nombre || 'el captor'}</strong> rechazó la colaboración para el requerimiento de su cliente.</p>
                ${razon ? `<div style="background:#fef2f2;border-left:3px solid #ef4444;padding:12px 16px;border-radius:6px;font-size:0.88rem;color:#444;margin-bottom:18px"><p style="margin:0 0 6px;font-weight:700;color:#991b1b">Razón:</p><p style="margin:0;line-height:1.5">${razon}</p></div>` : ''}
                <p style="font-size:0.85rem;color:#6b7a99">Puede buscar otro asesor con propiedades disponibles en la red de colaboración.</p>
                <div style="text-align:center;margin:20px 0 6px"><a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a></div>
              </div>
              <div style="background:#f4f6fb;padding:12px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Notificación de rechazo de colaboración</div>
            </div></body></html>`,
        });
      }
    } catch (err) { console.error('Error notificando rechazo captor:', err.message); }
  })();

  res.json({ ok: true });
});

// ── POST /api/leads/:id/convenio/responder-rechazo  (referente responde al rechazo del captor)
router.post('/:id/convenio/responder-rechazo', authMiddleware, (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_referente_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const referenteData = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'nota', `💬 Respuesta al rechazo (${referenteData?.nombre || 'referente'}): "${mensaje.trim()}"`);

  // Limpiar flags de rechazo cuando se responde — desaparece la notificación
  db.prepare('UPDATE leads SET convenio_rechazado_en = NULL, convenio_rechazado_por = NULL, convenio_rechazado_nota = NULL WHERE id = ?')
    .run(req.params.id);

  (async () => {
    try {
      const captor   = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_id);
      const referente = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
      if (captor?.email) {
        const { crearTransporter } = await import('../email.js');
        const transporter = crearTransporter();
        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: captor.email,
          subject: `💬 ${referente?.nombre || 'El referente'} respondió a tu rechazo de colaboración`,
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
            <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
              <div style="background:#1e2d4a;border-top:4px solid #3b82f6;padding:22px 32px">
                <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Red colaborativa · Respuesta al rechazo</p>
                <h1 style="margin:0;color:#fff;font-size:1.15rem">${referente?.nombre || 'El referente'} respondió a tu rechazo</h1>
              </div>
              <div style="padding:24px 32px">
                <p style="margin:0 0 14px;color:#444">Hola <strong>${captor.nombre || ''}</strong>, el asesor referente respondió al rechazo que enviaste:</p>
                <div style="background:#f0f4ff;border-left:3px solid #3b82f6;padding:12px 16px;border-radius:6px;font-size:0.9rem;color:#1e293b;margin-bottom:18px;line-height:1.5">"${mensaje.trim()}"</div>
                <p style="font-size:0.82rem;color:#6b7a99">Puede ingresar a su CRM para revisar y reconsiderar la colaboración si lo estima conveniente.</p>
                <div style="text-align:center;margin:20px 0 6px"><a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:7px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a></div>
              </div>
              <div style="background:#f4f6fb;padding:12px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Respuesta a rechazo de colaboración</div>
            </div></body></html>`,
        });
      }
    } catch (err) { console.error('Error enviando respuesta a rechazo:', err.message); }
  })();

  res.json({ ok: true });
});

// ── POST /api/leads/:id/convenio/limpiar-rechazo  (captor limpia flag para volver a proponer)
router.post('/:id/convenio/limpiar-rechazo', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  db.prepare('UPDATE leads SET convenio_rechazado_por = NULL, convenio_rechazado_nota = NULL, convenio_rechazado_en = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── PATCH /api/leads/:id/referente-comision  (referente actualiza fecha acordada / recibida)
router.patch('/:id/referente-comision', authMiddleware, (req, res) => {
  const { fecha_acordada, recibida } = req.body;
  const lead = db.prepare('SELECT asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_referente_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  if (fecha_acordada !== undefined) {
    db.prepare('UPDATE leads SET referente_fecha_comision = ? WHERE id = ?').run(fecha_acordada || null, req.params.id);
  }
  if (recibida !== undefined) {
    const valor = recibida ? new Date().toISOString() : null;
    db.prepare('UPDATE leads SET referente_comision_recibida_en = ? WHERE id = ?').run(valor, req.params.id);
  }
  res.json({ ok: true });
});

// ── GET /api/leads/recientes  (asesor autenticado — últimos 5 para dashboard)
router.get('/recientes', authMiddleware, (req, res) => {
  const leads = db.prepare(LEADS_SELECT + ' ORDER BY l.creado_en DESC LIMIT 5').all(req.usuario.id);
  res.json({ leads });
});

// ── PATCH /api/leads/:id/etapa  (asesor autenticado — mover en kanban)
router.patch('/:id/etapa', authMiddleware, (req, res) => {
  const { etapa, razon } = req.body;
  const etapasValidas = ['nuevo', 'agendado', 'visita-realizada', 'interesado', 'negociando', 'cerrado', 'inactivo', 'perdido', 'cliente-aprobado', 'contrato-agendado', 'comision-pagada'];
  if (!etapasValidas.includes(etapa))
    return res.status(400).json({ error: 'Etapa inválida' });

  const lead = db.prepare('SELECT asesor_id, etapa FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  if ((etapa === 'cerrado' || etapa === 'inactivo') && !razon)
    return res.status(400).json({ error: 'Debe seleccionar una razón al cerrar o descartar el lead' });

  const now = new Date().toISOString();
  if (razon) {
    db.prepare('UPDATE leads SET etapa = ?, razon_cierre = ?, ultima_bitacora_en = ?, actualizado_en = ? WHERE id = ?').run(etapa, razon, now, now, req.params.id);
  } else {
    db.prepare('UPDATE leads SET etapa = ?, actualizado_en = ? WHERE id = ?').run(etapa, now, req.params.id);
  }

  // Entrada automática en bitácora
  const tipoAuto = (etapa === 'cerrado' || etapa === 'inactivo') ? 'auto-cierre' : 'auto-etapa';
  const notaAuto = razon ? `Movido a "${etapa}" — razón: ${razon}` : `Movido a etapa "${etapa}"`;
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, tipoAuto, notaAuto);

  res.json({ ok: true });
});

// ── Bitácora ──────────────────────────────────────────────
router.get('/:id/bitacora', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id, asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const uid = req.usuario.id;
  if (lead.asesor_id !== uid && lead.asesor_referente_id !== uid)
    return res.status(403).json({ error: 'Sin permiso' });
  const rows = db.prepare(`
    SELECT b.*, u.nombre AS asesor_nombre
    FROM lead_bitacora b
    LEFT JOIN usuarios u ON u.id = b.asesor_id
    WHERE b.lead_id = ?
    ORDER BY b.creado_en DESC
  `).all(req.params.id);
  res.json({ bitacora: rows });
});

router.post('/:id/bitacora', authMiddleware, (req, res) => {
  const { tipo, nota } = req.body;
  const tiposValidos = ['llamada','whatsapp','email','reunion','nota'];
  if (!tiposValidos.includes(tipo))
    return res.status(400).json({ error: 'Tipo de interacción inválido' });
  if (!nota || !nota.trim())
    return res.status(400).json({ error: 'La nota es obligatoria' });

  const lead = db.prepare('SELECT asesor_id, asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const uid = req.usuario.id;
  if (lead.asesor_id !== uid && lead.asesor_referente_id !== uid)
    return res.status(403).json({ error: 'Sin permiso' });

  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, uid, tipo, nota.trim());
  db.prepare('UPDATE leads SET ultima_bitacora_en = ? WHERE id = ?')
    .run(new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

// ── PUT /api/leads/:id/notas  (asesor autenticado — guardar notas)
router.put('/:id/notas', authMiddleware, (req, res) => {
  const { notas } = req.body;
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  db.prepare('UPDATE leads SET notas = ? WHERE id = ?').run(notas || '', req.params.id);
  res.json({ ok: true });
});

// ── GET /api/leads/:id/datos-cierre  (asesor autenticado — obtener datos de comisión de la propiedad)
router.get('/:id/datos-cierre', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  let prop = null;
  if (lead.propiedad_id) {
    prop = db.prepare('SELECT id, titulo, operacion, precio, moneda, comision_pct, descuenta_mantenimiento, valor_mantenimiento FROM propiedades WHERE id = ?').get(lead.propiedad_id);
  }

  let referente = null;
  if (lead.asesor_referente_id) {
    referente = db.prepare('SELECT id, nombre, telefono, email FROM usuarios WHERE id = ?').get(lead.asesor_referente_id);
  }

  res.json({ lead, propiedad: prop, referente });
});

// ── POST /api/leads/:id/cerrar  (asesor autenticado — cierre con datos de comisión)
router.post('/:id/cerrar', authMiddleware, (req, res) => {
  const { valor_cierre, moneda } = req.body;
  if (!valor_cierre)
    return res.status(400).json({ error: 'Valor del cierre es requerido' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  // Obtener configuración de comisión de la propiedad
  let prop = null;
  if (lead.propiedad_id) {
    prop = db.prepare('SELECT tipo, operacion, precio, comision_pct, descuenta_mantenimiento, valor_mantenimiento FROM propiedades WHERE id = ?').get(lead.propiedad_id);
  }

  const valor = Number(valor_cierre);
  let comisionBruta;
  let comisionPct = null;

  if (prop && prop.operacion === 'renta') {
    // Renta: comisión = 1 mes de renta; el cliente envía el valor (ya convertido si aplica)
    // y la proporción mantenimiento/precio se mantiene aunque cambie la moneda
    const ratio = prop.descuenta_mantenimiento && prop.precio > 0
      ? (prop.precio - (prop.valor_mantenimiento || 0)) / prop.precio
      : 1;
    comisionBruta = Math.max(0, Math.round(valor * ratio));
  } else {
    // Venta: comisión = precio_cierre × comision_pct%
    comisionPct = prop?.comision_pct ?? 5;
    comisionBruta = Math.round(valor * comisionPct / 100);
  }

  // Split por modelo de negocio. Fallback a origen si el lead no tiene modelo (legacy).
  // 1D solo aplica si la propiedad fue subida directamente por un admin de InmobIA.
  let modelo = lead.modelo;
  if (!modelo) {
    if (lead.origen === 'tripartito') modelo = '4T';
    else if (lead.origen === 'inmobia' && propiedadEsDeAdmin(lead.propiedad_id)) modelo = '1D';
    else modelo = '2A';
  } else if (modelo === '1D' && !propiedadEsDeAdmin(lead.propiedad_id)) {
    // Defensa: si el lead venía marcado 1D pero la propiedad no es de admin, corregir a 2A.
    console.warn(`⚠️  Lead ${lead.id} marcado como 1D pero propiedad ${lead.propiedad_id} no pertenece a un admin. Reasignando a 2A.`);
    modelo = '2A';
  }
  const { inmobia: comisionInmobia, asesor: comisionAsesor, referente: comisionReferente } =
    splitComision(modelo, comisionBruta);

  const ahora = new Date().toISOString();
  db.prepare(`UPDATE leads SET etapa = 'cerrado', valor_cierre = ?, comision_pct = ?,
    comision_bruta = ?, comision_inmobia = ?, comision_asesor = ?, comision_referente = ?, moneda_cierre = ?, modelo = ?,
    cerrado_en = CURRENT_TIMESTAMP,
    cierre_declarado_en = ?,
    cierre_verificacion_estado = COALESCE(cierre_verificacion_estado, 'pendiente')
    WHERE id = ?`)
    .run(valor, comisionPct, comisionBruta, comisionInmobia, comisionAsesor, comisionReferente, moneda || 'GTQ', modelo, ahora, req.params.id);

  if (lead.propiedad_id) {
    const asesor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
    db.prepare('DELETE FROM transacciones WHERE propiedad_id = ?').run(lead.propiedad_id);
    db.prepare(`INSERT INTO transacciones (propiedad_id, tipo, comprador, asesor, precio_final, moneda, comision, notas)
      VALUES (?, 'cierre', ?, ?, ?, ?, ?, ?)`)
      .run(lead.propiedad_id, lead.nombre || '', asesor?.nombre || '', valor, moneda || 'GTQ',
        comisionInmobia, `Comisión Inmobia: ${moneda === 'USD' ? '$' : 'Q'}${comisionInmobia.toLocaleString()}`);
  }

  // Doble verificación — enviar al cliente un magic link para que confirme el cierre
  let verificacion = { enviado: false };
  if (lead.email) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
        .run(token, lead.email.toLowerCase().trim(), lead.id, expira);

      const asesor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
      const linkPanel = `${BASE_URL}/panel-cliente.html?token=${token}&accion=confirmar-cierre&lead=${lead.id}`;

      enviarCorreoVerificacionCierre({
        email: lead.email,
        nombreCliente: lead.nombre,
        nombreAsesor: asesor?.nombre,
        propiedadTitulo: lead.propiedad_titulo,
        valorCierre: valor,
        moneda: moneda || 'GTQ',
        linkPanel,
        tipoOperacion: prop?.operacion,
        tipoPropiedad: prop?.tipo,
      }).then(r => {
        if (r.ok) console.log('📧 Correo de verificación de cierre enviado a', lead.email);
      });
      verificacion = { enviado: true, email: lead.email };
    } catch (err) {
      console.warn('⚠️  No se pudo crear verificación de cierre:', err.message);
    }
  }

  // Sumar score al asesor por declarar cierre (+1.0)
  const scoreNuevo = sumarScore(req.usuario.id, 1.0);

  // Si es cierre colaborativo (5RA/4T), el referente también suma +0.2
  if ((modelo === '5RA' || modelo === '4T') && lead.asesor_referente_id) {
    sumarScore(lead.asesor_referente_id, 0.2);
  }

  res.json({
    ok: true,
    resumen: { valor, comisionBruta, comisionInmobia, comisionAsesor, moneda: moneda || 'GTQ' },
    verificacion_cliente: verificacion,
    score_nuevo: scoreNuevo,
    score_accion: 'cierre',
    score_delta: 1.0,
  });
});

// ── GET /api/leads/reporte-modelos  (asesor autenticado — métricas por modelo)
// Opcional ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD (default: año actual)
router.get('/reporte-modelos', authMiddleware, (req, res) => {
  const uid = req.usuario.id;
  const desde = req.query.desde || `${new Date().getFullYear()}-01-01`;
  const hasta = req.query.hasta || `${new Date().getFullYear()}-12-31`;

  // Leads donde el asesor es captor O referente, agrupados por modelo y rol
  const filas = db.prepare(`
    SELECT
      COALESCE(l.modelo,
        CASE l.origen WHEN 'tripartito' THEN '4T' WHEN 'inmobia' THEN '1D' ELSE '2A' END
      ) AS modelo,
      CASE WHEN l.asesor_id = ? THEN 'captor' ELSE 'referente' END AS rol,
      l.etapa,
      l.comision_asesor,
      l.comision_referente,
      l.comision_estado,
      l.referente_comision_recibida_en
    FROM leads l
    WHERE (l.asesor_id = ? OR l.asesor_referente_id = ?)
      AND DATE(l.creado_en) BETWEEN ? AND ?
  `).all(uid, uid, uid, desde, hasta);

  const resumen = {};
  const init = (m) => resumen[m] ||= {
    modelo: m,
    activos: 0, cerrados: 0,
    como_captor: { cerrados: 0, comision: 0, pendiente: 0 },
    como_referente: { cerrados: 0, comision: 0, pendiente: 0, recibida: 0 },
  };

  for (const f of filas) {
    const r = init(f.modelo);
    if (f.etapa === 'cerrado') {
      r.cerrados++;
      if (f.rol === 'captor') {
        r.como_captor.cerrados++;
        r.como_captor.comision += f.comision_asesor || 0;
        // 1D: track pending vs received payments from InmobIA
        if (f.modelo === '1D' && f.comision_estado !== 'recibida') {
          r.como_captor.pendiente += f.comision_asesor || 0;
        }
      } else {
        r.como_referente.cerrados++;
        r.como_referente.comision += f.comision_referente || 0;
        if (f.referente_comision_recibida_en) r.como_referente.recibida += f.comision_referente || 0;
        else r.como_referente.pendiente += f.comision_referente || 0;
      }
    } else if (f.etapa !== 'inactivo') {
      r.activos++;
    }
  }

  res.json({ desde, hasta, modelos: Object.values(resumen) });
});

// ── GET /api/leads/admin/reporte-modelos  (admin — vista global por modelo)
router.get('/admin/reporte-modelos', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const desde = req.query.desde || `${new Date().getFullYear()}-01-01`;
  const hasta = req.query.hasta || `${new Date().getFullYear()}-12-31`;

  const filas = db.prepare(`
    SELECT
      COALESCE(l.modelo,
        CASE l.origen WHEN 'tripartito' THEN '4T' WHEN 'inmobia' THEN '1D' ELSE '2A' END
      ) AS modelo,
      l.etapa, l.valor_cierre, l.comision_inmobia, l.asesor_id, l.asesor_referente_id
    FROM leads l
    WHERE DATE(l.creado_en) BETWEEN ? AND ?
  `).all(desde, hasta);

  const resumen = {};
  const init = (m) => resumen[m] ||= {
    modelo: m, leads_totales: 0, cerrados: 0,
    ingreso_inmobia: 0, volumen_cierres: 0,
    asesores: new Set(),
  };

  for (const f of filas) {
    const r = init(f.modelo);
    r.leads_totales++;
    if (f.asesor_id) r.asesores.add(f.asesor_id);
    if (f.asesor_referente_id) r.asesores.add(f.asesor_referente_id);
    if (f.etapa === 'cerrado') {
      r.cerrados++;
      r.ingreso_inmobia += f.comision_inmobia || 0;
      r.volumen_cierres += f.valor_cierre || 0;
    }
  }

  const modelos = Object.values(resumen).map(r => ({
    modelo: r.modelo,
    leads_totales: r.leads_totales,
    cerrados: r.cerrados,
    asesores_activos: r.asesores.size,
    ingreso_inmobia: r.ingreso_inmobia,
    ticket_promedio: r.cerrados ? Math.round(r.volumen_cierres / r.cerrados) : 0,
    tasa_cierre: r.leads_totales ? +(r.cerrados / r.leads_totales * 100).toFixed(1) : 0,
  }));

  // Modelo 3S · Suscripciones Premium (no genera leads — ingreso recurrente)
  const premiumCount = db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'asesor' AND plan = 'premium'`).get()?.n || 0;
  const tarifa = 399;
  // Meses cubiertos por el rango (aprox)
  const d1 = new Date(desde), d2 = new Date(hasta);
  const mesesRango = Math.max(1, (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth()) + 1);
  const ingresoPremium = premiumCount * tarifa * mesesRango;

  const suscripcion = {
    modelo: '3S',
    suscriptores_activos: premiumCount,
    tarifa_mensual: tarifa,
    meses_rango: mesesRango,
    ingreso_inmobia: ingresoPremium,
  };

  res.json({ desde, hasta, modelos, suscripcion });
});

// ── Modelo 1D · pago al asesor por transferencia bancaria ──
// Estados: por_recibir → programada → transferida → recibida

// POST /api/leads/admin/:id/programar-pago-asesor — admin registra fecha programada
router.post('/admin/:id/programar-pago-asesor', authMiddleware, async (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });

  const { fecha_pago, referencia, notas } = req.body;
  if (!fecha_pago || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_pago)) {
    return res.status(400).json({ error: 'Fecha de pago inválida (formato YYYY-MM-DD)' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.modelo !== '1D') return res.status(400).json({ error: 'Solo aplica al modelo 1D' });
  if (!propiedadEsDeAdmin(lead.propiedad_id)) return res.status(400).json({ error: 'La propiedad no fue subida por un admin de InmobIA — no califica como 1D' });
  if (lead.cierre_verificacion_estado !== 'confirmado') return res.status(409).json({ error: 'El cliente aún no confirma el cierre' });

  db.prepare(`UPDATE leads SET pago_asesor_fecha_programada = ?, pago_asesor_referencia = ?, pago_asesor_notas = ?, comision_estado = 'programada' WHERE id = ?`)
    .run(fecha_pago, (referencia || '').slice(0, 200) || null, (notas || '').slice(0, 1000) || null, lead.id);

  // Notificar al asesor
  const asesor = db.prepare('SELECT email, nombre FROM usuarios WHERE id = ?').get(lead.asesor_id);
  if (asesor?.email) {
    enviarCorreoPagoProgramado1D({
      email: asesor.email,
      nombreAsesor: asesor.nombre,
      propiedadTitulo: lead.propiedad_titulo,
      comisionAsesor: lead.comision_asesor,
      moneda: lead.moneda_cierre || 'GTQ',
      fechaPago: fecha_pago,
      referencia,
      notas,
    }).then(r => { if (r.ok) console.log('📧 Pago programado enviado a', asesor.email); });
  }

  res.json({ ok: true, estado: 'programada', fecha_pago });
});

// POST /api/leads/admin/:id/marcar-pago-transferido — admin confirma que se hizo la transferencia
router.post('/admin/:id/marcar-pago-transferido', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });

  const { referencia, notas } = req.body;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.modelo !== '1D') return res.status(400).json({ error: 'Solo aplica al modelo 1D' });
  if (!['programada', 'por_recibir'].includes(lead.comision_estado)) {
    return res.status(409).json({ error: 'Estado inválido para marcar transferencia' });
  }

  const ahora = new Date().toISOString();
  db.prepare(`UPDATE leads SET pago_asesor_pagado_en = ?, comision_estado = 'transferida',
    pago_asesor_referencia = COALESCE(?, pago_asesor_referencia),
    pago_asesor_notas = COALESCE(?, pago_asesor_notas)
    WHERE id = ?`)
    .run(ahora, (referencia || '').slice(0, 200) || null, (notas || '').slice(0, 1000) || null, lead.id);

  res.json({ ok: true, estado: 'transferida', transferido_en: ahora });
});

// POST /api/leads/:id/confirmar-pago-asesor — asesor confirma que recibió el pago
router.post('/:id/confirmar-pago-asesor', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (lead.modelo !== '1D') return res.status(400).json({ error: 'Solo aplica al modelo 1D' });
  if (lead.comision_estado === 'recibida') return res.json({ ok: true, ya_confirmado: true });
  if (lead.comision_estado !== 'transferida') {
    return res.status(409).json({ error: 'InmobIA aún no marca el pago como transferido' });
  }

  const ahora = new Date().toISOString();
  db.prepare(`UPDATE leads SET comision_estado = 'recibida', comision_pagada_en = ? WHERE id = ?`)
    .run(ahora, lead.id);

  res.json({ ok: true, estado: 'recibida', confirmado_en: ahora });
});

// ── Flujo progresivo 5RA/4T ─────────────────────────────────

// PATCH /api/leads/:id/5ra/visita  — cada asesor confirma la fecha de visita (doble confirmación)
router.patch('/:id/5ra/visita', authMiddleware, async (req, res) => {
  const { fecha } = req.body;
  const lead = db.prepare(`
    SELECT asesor_id, asesor_referente_id, convenio_captor_en, convenio_referente_en,
           visita_captor_confirmada_en, visita_referente_confirmada_en, visita_coordinada_en,
           email, nombre, propiedad_titulo, visita_cliente_magic_enviado_en
    FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const esCaptor = lead.asesor_id === req.usuario.id;
  const esReferente = lead.asesor_referente_id === req.usuario.id;
  if (!esCaptor && !esReferente) return res.status(403).json({ error: 'Sin permiso' });
  if (!lead.convenio_captor_en || !lead.convenio_referente_en)
    return res.status(400).json({ error: 'Ambos deben firmar el convenio primero' });
  if (!fecha) return res.status(400).json({ error: 'Ingrese la fecha y hora de la visita' });

  const ahora = new Date().toISOString();
  const fechaCambia = lead.visita_coordinada_en !== fecha;

  let ambosConfirmaron = false;

  if (esCaptor) {
    const refConf = fechaCambia ? null : lead.visita_referente_confirmada_en;
    db.prepare(`UPDATE leads SET visita_coordinada_en = ?, visita_captor_confirmada_en = ?, visita_referente_confirmada_en = ? WHERE id = ?`)
      .run(fecha, ahora, refConf, req.params.id);
    if (!fechaCambia && lead.visita_referente_confirmada_en) {
      db.prepare(`UPDATE leads SET etapa = 'agendado', convenio_aceptado_en = COALESCE(convenio_aceptado_en, ?) WHERE id = ?`).run(ahora, req.params.id);
      db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
        .run(req.params.id, req.usuario.id, 'auto-etapa', `Visita confirmada por ambos asesores para ${fecha}`);
      ambosConfirmaron = true;
    }
  } else {
    const capConf = fechaCambia ? null : lead.visita_captor_confirmada_en;
    db.prepare(`UPDATE leads SET visita_coordinada_en = ?, visita_referente_confirmada_en = ?, visita_captor_confirmada_en = ? WHERE id = ?`)
      .run(fecha, ahora, capConf, req.params.id);
    if (!fechaCambia && lead.visita_captor_confirmada_en) {
      db.prepare(`UPDATE leads SET etapa = 'agendado', convenio_aceptado_en = COALESCE(convenio_aceptado_en, ?) WHERE id = ?`).run(ahora, req.params.id);
      db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
        .run(req.params.id, req.usuario.id, 'auto-etapa', `Visita confirmada por ambos asesores para ${fecha}`);
      ambosConfirmaron = true;
    }
  }

  // Cuando ambos confirman: notificar al cliente con magic link (solo si aún no se envió para esta fecha)
  if (ambosConfirmaron && lead.email && !lead.visita_cliente_magic_enviado_en) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
        .run(token, lead.email.toLowerCase().trim(), req.params.id, expira);
      const linkPanel = `${BASE_URL}/panel-cliente.html?token=${token}&accion=confirmar-visita&lead=${req.params.id}`;
      const captor   = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lead.asesor_id);
      const referente = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lead.asesor_referente_id);
      await enviarCorreoVisitaConfirmada5RA({
        email: lead.email,
        nombreCliente: lead.nombre,
        nombreCaptor: captor?.nombre,
        nombreReferente: referente?.nombre,
        propiedadTitulo: lead.propiedad_titulo,
        fechaVisita: fecha,
        linkPanel,
      });
      db.prepare('UPDATE leads SET visita_cliente_magic_enviado_en = ? WHERE id = ?').run(ahora, req.params.id);
    } catch (err) {
      console.error('⚠️  Error enviando notificación visita al cliente:', err.message);
    }
  }

  const updated = db.prepare('SELECT visita_captor_confirmada_en, visita_referente_confirmada_en, etapa FROM leads WHERE id = ?').get(req.params.id);
  res.json({ ok: true, ...updated });
});

// POST /api/leads/:id/5ra/visita-link-cliente — genera magic link para que el asesor lo envíe al cliente por WhatsApp
router.post('/:id/5ra/visita-link-cliente', authMiddleware, (req, res) => {
  const lead = db.prepare(`
    SELECT asesor_id, asesor_referente_id, email, nombre, propiedad_titulo,
           visita_captor_confirmada_en, visita_referente_confirmada_en
    FROM leads WHERE id = ?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const esCaptor    = lead.asesor_id === req.usuario.id;
  const esReferente = lead.asesor_referente_id === req.usuario.id;
  if (!esCaptor && !esReferente) return res.status(403).json({ error: 'Sin permiso' });
  if (!lead.visita_captor_confirmada_en || !lead.visita_referente_confirmada_en)
    return res.status(409).json({ error: 'Ambos asesores deben confirmar la visita primero' });
  if (!lead.email) return res.status(409).json({ error: 'El cliente no tiene email registrado' });

  const token  = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
    .run(token, lead.email.toLowerCase().trim(), req.params.id, expira);

  const link = `${BASE_URL}/panel-cliente.html?token=${token}&accion=confirmar-visita&lead=${req.params.id}`;
  res.json({ ok: true, link, nombreCliente: lead.nombre, propiedadTitulo: lead.propiedad_titulo });
});

// ── Mapa de progreso del REFERENTE (5RA) ────────────────────

function soloReferente(req, res) {
  const lead = db.prepare('SELECT asesor_referente_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) { res.status(404).json({ error: 'Lead no encontrado' }); return null; }
  if (lead.asesor_referente_id !== req.usuario.id) { res.status(403).json({ error: 'Sin permiso' }); return null; }
  return lead;
}

// PATCH /api/leads/:id/referente/resultado — el referente reporta cómo reaccionó su cliente
router.patch('/:id/referente/resultado', authMiddleware, (req, res) => {
  if (!soloReferente(req, res)) return;
  const { resultado, nota } = req.body;
  const validos = ['interesado', 'negociando', 'no-interesado'];
  if (!validos.includes(resultado)) return res.status(400).json({ error: 'Resultado inválido' });
  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET ref_resultado_visita = ?, ref_resultado_visita_en = ?, ref_resultado_nota = ? WHERE id = ?')
    .run(resultado, ahora, nota || null, req.params.id);
  const etiqMap = { interesado: 'Cliente interesado', negociando: 'Cliente en negociación', 'no-interesado': 'Cliente no interesado' };
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Referente] ${etiqMap[resultado]}${nota ? ': ' + nota : ''}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/referente/papeleria — el referente reporta el estado de papelería de su cliente
router.patch('/:id/referente/papeleria', authMiddleware, (req, res) => {
  if (!soloReferente(req, res)) return;
  const { estado, fecha } = req.body;
  const validos = ['entregada', 'completa', 'incompleta'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  db.prepare('UPDATE leads SET ref_papeleria_estado = ?, ref_papeleria_fecha = ? WHERE id = ?')
    .run(estado, fecha || new Date().toISOString(), req.params.id);
  const etiq = { entregada: 'Papelería entregada por el cliente', completa: 'Papelería completa y aprobada', incompleta: 'Papelería incompleta — requiere documentos adicionales' };
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Referente] ${etiq[estado]}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/referente/contrato — el referente confirma que se firmó el contrato
router.patch('/:id/referente/contrato', authMiddleware, (req, res) => {
  if (!soloReferente(req, res)) return;
  const { fecha_firma, hora_firma, lugar_firma } = req.body;
  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET ref_contrato_confirmado_en = ?, ref_contrato_fecha_firma = ?, ref_contrato_hora_firma = ?, ref_contrato_lugar_firma = ? WHERE id = ?')
    .run(ahora, fecha_firma || null, hora_firma || null, lugar_firma || null, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Referente] Firma de contrato confirmada${fecha_firma ? ` · ${fecha_firma}` : ''}${hora_firma ? ` a las ${hora_firma}` : ''}${lugar_firma ? ` en ${lugar_firma}` : ''}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/referente/cierre — el referente compromete fechas de pago
router.patch('/:id/referente/cierre', authMiddleware, (req, res) => {
  if (!soloReferente(req, res)) return;
  const { fecha_cobro_acordada, fecha_pago_inmobia } = req.body;
  if (!fecha_pago_inmobia) return res.status(400).json({ error: 'Ingrese la fecha de pago a InmobIA' });
  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET ref_fecha_cobro_acordada = ?, ref_fecha_pago_inmobia = ?, ref_cierre_declarado_en = ? WHERE id = ?')
    .run(fecha_cobro_acordada || null, fecha_pago_inmobia, ahora, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Referente] Fechas de pago comprometidas · cobro del captor: ${fecha_cobro_acordada || 'por acordar'} · pago a InmobIA: ${fecha_pago_inmobia}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/referente/comision — el referente registra su pago de comisión a InmobIA
router.patch('/:id/referente/comision', authMiddleware, (req, res) => {
  if (!soloReferente(req, res)) return;
  const { tipo } = req.body; // en-linea | transferencia
  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET ref_comision_pago_en = ?, ref_comision_pago_tipo = ? WHERE id = ?')
    .run(ahora, tipo || 'transferencia', req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Referente] Comisión pagada a InmobIA (${tipo || 'transferencia'})`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/resultado — resultado de la visita (interesado / negociando / inactivo)
router.patch('/:id/5ra/resultado', authMiddleware, (req, res) => {
  const { resultado } = req.body;
  const validos = ['interesado', 'negociando', 'inactivo'];
  if (!validos.includes(resultado)) return res.status(400).json({ error: 'Resultado inválido' });
  const lead = db.prepare('SELECT asesor_id, etapa FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  db.prepare('UPDATE leads SET etapa = ? WHERE id = ?').run(resultado, req.params.id);
  const notas = { interesado: 'Cliente interesado', negociando: 'En negociación', inactivo: 'No interesado' };
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', notas[resultado]);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/papeleria — registra fecha y estado de papelería
router.patch('/:id/5ra/papeleria', authMiddleware, (req, res) => {
  const { fecha, estado, comentario } = req.body;
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const campos = [];
  const vals = [];
  if (fecha !== undefined) { campos.push('papeleria_fecha = ?'); vals.push(fecha || null); }
  if (estado !== undefined) { campos.push('papeleria_estado = ?'); vals.push(estado || null); }
  if (comentario !== undefined) { campos.push('papeleria_comentario = ?'); vals.push(comentario || null); }

  let nuevaEtapa = null;
  if (estado === 'aprobada') { campos.push('etapa = ?'); vals.push('cliente-aprobado'); nuevaEtapa = 'cliente-aprobado'; }

  if (campos.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  vals.push(req.params.id);
  db.prepare(`UPDATE leads SET ${campos.join(', ')} WHERE id = ?`).run(...vals);

  if (nuevaEtapa) {
    db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
      .run(req.params.id, req.usuario.id, 'auto-etapa', 'Papelería aprobada — cliente aprobado');
  } else if (estado) {
    const notas = { 'no-aprobada': 'Papelería no aprobada', incompleta: 'Papelería incompleta' };
    if (notas[estado]) {
      db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
        .run(req.params.id, req.usuario.id, 'auto-etapa', notas[estado] + (comentario ? `: ${comentario}` : ''));
    }
  }
  res.json({ ok: true, nueva_etapa: nuevaEtapa });
});

// PATCH /api/leads/:id/5ra/contrato — registra fecha, hora y lugar del contrato
router.patch('/:id/5ra/contrato', authMiddleware, (req, res) => {
  const { fecha, hora, lugar } = req.body;
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  db.prepare(`UPDATE leads SET contrato_fecha = ?, contrato_hora = ?, contrato_lugar = ?, etapa = 'contrato-agendado' WHERE id = ?`)
    .run(fecha, hora || null, lugar || null, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `Contrato firmado${fecha ? ' · ' + fecha : ''}${hora ? ' a las ' + hora : ''}${lugar ? ' en ' + lugar : ''}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/cierre — el captor compromete fechas de pago a colega e InmobIA
router.patch('/:id/5ra/cierre', authMiddleware, (req, res) => {
  const { fecha_cobro_propietario, fecha_pago_referente, fecha_pago_inmobia } = req.body;
  if (!fecha_pago_inmobia) return res.status(400).json({ error: 'Ingrese la fecha de pago a InmobIA' });
  if (!fecha_pago_referente) return res.status(400).json({ error: 'Ingrese la fecha de pago a su colega' });
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET ref_fecha_cobro_acordada = ?, ref_fecha_pago_referente = ?, ref_fecha_pago_inmobia = ?, ref_cierre_declarado_en = ? WHERE id = ?')
    .run(fecha_cobro_propietario || null, fecha_pago_referente, fecha_pago_inmobia, ahora, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-etapa', `[Captor] Fechas de pago comprometidas · pago a colega: ${fecha_pago_referente} · pago a InmobIA: ${fecha_pago_inmobia}`);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/pagos — registra pagos de depósito y primera renta
router.patch('/:id/5ra/pagos', authMiddleware, (req, res) => {
  const { deposito_fecha, deposito_monto, primera_renta_fecha, primera_renta_monto } = req.body;
  const lead = db.prepare('SELECT asesor_id, etapa FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const campos = [];
  const vals = [];
  if (deposito_fecha !== undefined) { campos.push('deposito_fecha = ?'); vals.push(deposito_fecha || null); }
  if (deposito_monto !== undefined) { campos.push('deposito_monto = ?'); vals.push(Number(deposito_monto) || null); }
  if (primera_renta_fecha !== undefined) { campos.push('primera_renta_fecha = ?'); vals.push(primera_renta_fecha || null); }
  if (primera_renta_monto !== undefined) { campos.push('primera_renta_monto = ?'); vals.push(Number(primera_renta_monto) || null); }

  if (campos.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  vals.push(req.params.id);
  db.prepare(`UPDATE leads SET ${campos.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/cerrar — marca como cerrado (pagos completos)
router.patch('/:id/5ra/cerrar', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const now = new Date().toISOString();
  db.prepare(`UPDATE leads SET etapa = 'cerrado', cerrado_en = ? WHERE id = ?`).run(now, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-cierre', 'Pagos completados — lead cerrado');
  res.json({ ok: true });
});

// PATCH /api/leads/:id/5ra/comision-inmobia — registra pago de comisión a InmobIA
router.patch('/:id/5ra/comision-inmobia', authMiddleware, (req, res) => {
  const { fecha, tipo, token } = req.body;
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  db.prepare(`UPDATE leads SET comision_pago_fecha = ?, comision_pago_tipo = ?, etapa = 'comision-pagada', comision_estado = 'pagada', comision_pagada_en = ? WHERE id = ?`)
    .run(fecha || null, tipo || null, new Date().toISOString(), req.params.id);

  if (tipo === 'transferencia' || tipo === 'deposito') {
    (async () => {
      try {
        const admin = db.prepare(`SELECT email, nombre FROM usuarios WHERE rol = 'admin' LIMIT 1`).get();
        const asesorData = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lead.asesor_id);
        const leadFull = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
        if (admin?.email) {
          const { crearTransporter } = await import('../email.js');
          const tr = crearTransporter();
          await tr.sendMail({
            from: `"InmobIA" <${process.env.SMTP_USER}>`,
            to: admin.email,
            subject: `💰 Pago de comisión pendiente de confirmación — ${asesorData?.nombre || 'Asesor'}`,
            html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
              <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:#1e2d4a;border-top:4px solid #c9a84c;padding:22px 32px">
                  <h1 style="margin:0;color:#fff;font-size:1.1rem">Pago de comisión por confirmar</h1>
                </div>
                <div style="padding:22px 32px;font-size:0.9rem;color:#444">
                  <p><strong>Asesor:</strong> ${asesorData?.nombre || '—'}</p>
                  <p><strong>Lead ID:</strong> ${lead.id}</p>
                  <p><strong>Propiedad:</strong> ${leadFull?.propiedad_titulo || '—'}</p>
                  <p><strong>Tipo de pago:</strong> ${tipo}</p>
                  <p><strong>Fecha registrada:</strong> ${fecha || '—'}</p>
                  ${token ? `<p><strong>Token/referencia:</strong> ${token}</p>` : ''}
                  <p style="margin-top:18px;background:#fff7e3;border-left:3px solid #c9a84c;padding:10px 14px;border-radius:6px">Confirma esta transacción en el panel de administración.</p>
                </div>
              </div></body></html>`,
          });
        }
      } catch (err) { console.error('Error notificando pago comisión al admin:', err.message); }
    })();
  }

  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)')
    .run(req.params.id, req.usuario.id, 'auto-cierre', `Comisión InmobIA pagada via ${tipo || 'pago'}`);
  res.json({ ok: true });
});

// ── POST /api/leads/crear-directo  (asesor crea un lead manual — origen 1D)
router.post('/crear-directo', authMiddleware, (req, res) => {
  const { nombre, telefono, email, notas, propiedad_id } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

  let propTitulo = null;
  if (propiedad_id) {
    const prop = db.prepare('SELECT titulo, codigo FROM propiedades WHERE id = ? AND asesor_id = ?').get(Number(propiedad_id), req.usuario.id);
    if (prop) propTitulo = prop.titulo || prop.codigo || null;
  }

  const info = db.prepare(`
    INSERT INTO leads (asesor_id, nombre, telefono, email, notas, propiedad_id, propiedad_titulo, etapa, origen, tipo, modelo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'nuevo', 'manual', 'manual', 'directo')
  `).run(req.usuario.id, nombre.trim(), telefono?.trim() || null, email?.trim() || null, notas?.trim() || null, propiedad_id ? Number(propiedad_id) : null, propTitulo);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, lead });
});

// ── POST /api/leads/importar-csv  (asesor importa leads desde CSV — origen 1D)
router.post('/importar-csv', authMiddleware, (req, res) => {
  const { filas } = req.body; // [{ nombre, telefono, email, notas }]
  if (!Array.isArray(filas) || filas.length === 0)
    return res.status(400).json({ error: 'Sin filas válidas' });
  if (filas.length > 500)
    return res.status(400).json({ error: 'Máximo 500 filas por importación' });

  const insert = db.prepare(`
    INSERT INTO leads (asesor_id, nombre, telefono, email, notas, etapa, origen, tipo, modelo)
    VALUES (?, ?, ?, ?, ?, 'nuevo', 'manual', 'manual', 'directo')
  `);

  let insertados = 0;
  let errores = 0;
  const insertMany = db.transaction((rows) => {
    for (const f of rows) {
      const nombre = (f.nombre || '').trim();
      if (!nombre) { errores++; continue; }
      insert.run(req.usuario.id, nombre, (f.telefono || '').trim() || null, (f.email || '').trim() || null, (f.notas || '').trim() || null);
      insertados++;
    }
  });
  insertMany(filas);

  res.json({ ok: true, insertados, errores });
});

// ── DELETE /api/leads/:id  (asesor autenticado)
router.delete('/:id', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── GET /api/leads/historial/notificaciones  (admin obtiene historial de notificaciones de agendamiento)
router.get('/historial/notificaciones', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (user?.rol !== 'admin') return res.status(403).json({ error: 'Sin permiso' });

  const notificaciones = [];
  const leads = db.prepare(`
    SELECT id, nombre, asesor_id, asesor_referente_id, convenio_aceptado_en,
           notif_agendamiento_24h_en, notif_agendamiento_72h_en,
           notif_agendamiento_120h_en, alerta_inmobia_144h_en,
           agendamiento_nota, fecha_visita
    FROM leads
    WHERE convenio_aceptado_en IS NOT NULL
    ORDER BY convenio_aceptado_en DESC
  `).all();

  for (const lead of leads) {
    const captor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lead.asesor_id);
    const referente = lead.asesor_referente_id
      ? db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(lead.asesor_referente_id)
      : null;

    if (lead.notif_agendamiento_24h_en) {
      notificaciones.push({
        tipo: '24h',
        lead_id: lead.id,
        cliente: lead.nombre,
        captor: captor?.nombre,
        referente: referente?.nombre,
        enviado_en: lead.notif_agendamiento_24h_en,
        convenio_aceptado_en: lead.convenio_aceptado_en,
        fecha_visita: lead.fecha_visita,
        estado: lead.fecha_visita ? 'completado' : 'pendiente',
      });
    }

    if (lead.notif_agendamiento_72h_en) {
      notificaciones.push({
        tipo: '72h',
        lead_id: lead.id,
        cliente: lead.nombre,
        captor: captor?.nombre,
        referente: referente?.nombre,
        enviado_en: lead.notif_agendamiento_72h_en,
        convenio_aceptado_en: lead.convenio_aceptado_en,
        fecha_visita: lead.fecha_visita,
        estado: lead.fecha_visita ? 'completado' : 'pendiente',
      });
    }

    if (lead.notif_agendamiento_120h_en) {
      notificaciones.push({
        tipo: '120h',
        lead_id: lead.id,
        cliente: lead.nombre,
        captor: captor?.nombre,
        referente: referente?.nombre,
        enviado_en: lead.notif_agendamiento_120h_en,
        convenio_aceptado_en: lead.convenio_aceptado_en,
        fecha_visita: lead.fecha_visita,
        estado: lead.fecha_visita ? 'completado' : 'pendiente',
      });
    }

    if (lead.alerta_inmobia_144h_en) {
      notificaciones.push({
        tipo: 'alerta-144h',
        lead_id: lead.id,
        cliente: lead.nombre,
        captor: captor?.nombre,
        referente: referente?.nombre,
        enviado_en: lead.alerta_inmobia_144h_en,
        convenio_aceptado_en: lead.convenio_aceptado_en,
        fecha_visita: lead.fecha_visita,
        estado: lead.fecha_visita ? 'completado' : 'critico',
        nota: lead.agendamiento_nota,
      });
    }
  }

  res.json({ notificaciones: notificaciones.sort((a, b) => new Date(b.enviado_en) - new Date(a.enviado_en)) });
});

// ── Consultas desde el portal (tipo='consulta') ───────────────────────────

// GET /api/leads/:id/consulta/mensajes — historial de mensajes (asesor autenticado)
router.get('/:id/consulta/mensajes', authMiddleware, (req, res) => {
  const lead = db.prepare('SELECT asesor_id, tipo FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id && req.usuario.rol !== 'admin')
    return res.status(403).json({ error: 'Sin permiso' });
  const mensajes = db.prepare('SELECT * FROM consulta_mensajes WHERE lead_id = ? ORDER BY creado_en ASC').all(req.params.id);
  res.json({ mensajes });
});

// POST /api/leads/:id/consulta/responder — asesor escribe respuesta
router.post('/:id/consulta/responder', authMiddleware, (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const lead = db.prepare('SELECT asesor_id, nombre, telefono, propiedad_titulo FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });

  const ahora = new Date().toISOString();
  db.prepare('INSERT INTO consulta_mensajes (lead_id, de, mensaje) VALUES (?,?,?)').run(req.params.id, 'asesor', mensaje.trim());
  db.prepare('UPDATE leads SET ultima_bitacora_en = ? WHERE id = ?').run(ahora, req.params.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?,?,?,?)').run(req.params.id, req.usuario.id, 'consulta-respuesta', mensaje.trim().slice(0, 200));

  const msg = db.prepare('SELECT id FROM consulta_mensajes WHERE lead_id = ? ORDER BY creado_en DESC LIMIT 1').get(req.params.id);
  res.json({ ok: true, id: msg?.id });
});

// POST /api/leads/:id/consulta/marcar-enviado — admin marca mensaje como enviado por WhatsApp
router.post('/:id/consulta/marcar-enviado', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { mensaje_id } = req.body;
  db.prepare('UPDATE consulta_mensajes SET enviado_wa = 1, enviado_en = ? WHERE id = ? AND lead_id = ?')
    .run(new Date().toISOString(), mensaje_id, req.params.id);
  res.json({ ok: true });
});

// GET /api/leads/consultas/pendientes — admin: mensajes de asesor pendientes de envío WA
router.get('/consultas/pendientes', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const pendientes = db.prepare(`
    SELECT cm.*, l.nombre AS cliente_nombre, l.telefono AS cliente_telefono,
           l.propiedad_titulo, u.nombre AS asesor_nombre
    FROM consulta_mensajes cm
    JOIN leads l ON l.id = cm.lead_id
    JOIN usuarios u ON u.id = l.asesor_id
    WHERE cm.de = 'asesor' AND cm.enviado_wa = 0
    ORDER BY cm.creado_en ASC
  `).all();
  res.json({ pendientes });
});

// POST /api/leads/:id/solicitar-calificacion  (asesor autenticado)
router.post('/:id/solicitar-calificacion', authMiddleware, async (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, p.operacion AS prop_operacion
    FROM leads l LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE l.id = ?
  `).get(req.params.id);

  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (lead.asesor_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (!lead.email) return res.status(409).json({ error: 'El cliente no tiene email registrado' });
  if (!lead.visita_realizada_en) return res.status(409).json({ error: 'Primero marca la visita como realizada' });
  if (lead.calificacion_cliente) return res.status(409).json({ error: 'El cliente ya dejó una calificación' });

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(); // 15 días
  db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
    .run(token, lead.email.toLowerCase().trim(), lead.id, expira);

  const asesor = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.usuario.id);
  const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
  const linkCalificar = `${BASE_URL}/panel-cliente.html?token=${token}&accion=calificar&lead=${lead.id}`;

  const r = await enviarCorreoSolicitarCalificacion({
    email: lead.email,
    nombreCliente: lead.nombre,
    nombreAsesor: asesor?.nombre,
    propiedadTitulo: lead.propiedad_titulo,
    linkCalificar,
  });

  if (r.ok) {
    console.log('📧 Solicitud de calificación enviada a', lead.email);
    res.json({ ok: true, email: lead.email });
  } else {
    res.status(500).json({ error: 'No se pudo enviar el correo', detalle: r.error });
  }
});

export default router;
