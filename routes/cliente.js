import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../database.js';
import { crearCheckoutComision, keysConfigured } from '../lib/recurrente.js';
import { propiedadEsDeAdmin } from '../lib/modelos.js';
import { enviarCorreoComisionAsesor, enviarCorreoCierreConfirmado1D } from '../email.js';

const router = Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// Genera el link wa.me que el asesor puede usar para reenviar el pago por WhatsApp
function buildWhatsAppLink({ telefono, mensaje }) {
  if (!telefono) return '';
  const soloDigitos = String(telefono).replace(/\D/g, '');
  // Prepend 502 (GT) si no viene con código país
  const intl = soloDigitos.length === 8 ? `502${soloDigitos}` : soloDigitos;
  return `https://wa.me/${intl}?text=${encodeURIComponent(mensaje)}`;
}

// Dispara (idempotente) la generación del link de comisión + notificaciones
// Bifurca por modelo:
//   - 1D: InmobIA es dueña de la propiedad → InmobIA paga al asesor por transferencia (no genera checkout).
//   - 2A/4T/5RA: el asesor recibe el pago del cliente y le paga a InmobIA (genera checkout Recurrente).
async function generarCobroComision(leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return { ok: false, motivo: 'lead_no_existe' };

  const asesor = db.prepare('SELECT id, nombre, email, telefono FROM usuarios WHERE id = ?').get(lead.asesor_id);
  if (!asesor) return { ok: false, motivo: 'asesor_no_existe' };

  // ── Modelo 1D: InmobIA paga al asesor (flujo invertido) ──
  // Solo aplica si la propiedad fue subida directamente por un admin de InmobIA.
  // Si el lead vino marcado como 1D pero la propiedad no es de admin, se descarta el flujo invertido.
  if (lead.modelo === '1D') {
    if (!propiedadEsDeAdmin(lead.propiedad_id)) {
      console.warn(`⚠️  Lead ${leadId} marcado 1D pero propiedad ${lead.propiedad_id} no pertenece a admin. Se omite flujo invertido.`);
      return { ok: false, motivo: 'propiedad_no_es_de_admin' };
    }
    if (lead.comision_estado === 'por_recibir' || lead.comision_estado === 'programada' || lead.comision_estado === 'recibida') {
      return { ok: true, ya_generado: true, modelo: '1D', estado: lead.comision_estado };
    }
    if (!lead.comision_asesor || lead.comision_asesor <= 0) return { ok: false, motivo: 'sin_comision_asesor' };

    const ahora = new Date().toISOString();
    db.prepare(`UPDATE leads SET comision_estado = 'por_recibir', comision_link_creado_en = ? WHERE id = ?`)
      .run(ahora, leadId);

    enviarCorreoCierreConfirmado1D({
      email: asesor.email,
      nombreAsesor: asesor.nombre,
      nombreCliente: lead.nombre,
      propiedadTitulo: lead.propiedad_titulo,
      valorCierre: lead.valor_cierre,
      comisionAsesor: lead.comision_asesor,
      moneda: lead.moneda_cierre || 'GTQ',
    }).then(r => {
      if (r.ok) console.log('📧 Correo cierre 1D enviado a', asesor.email);
    });

    return { ok: true, modelo: '1D', flujo: 'inmobia_paga_asesor', monto_a_recibir: lead.comision_asesor };
  }

  // ── Modelos 2A/4T/5RA: el asesor paga a InmobIA ──
  if (lead.comision_link_pago) return { ok: true, ya_generado: true, link: lead.comision_link_pago };
  if (!lead.comision_inmobia || lead.comision_inmobia <= 0) return { ok: false, motivo: 'sin_comision' };
  if (!keysConfigured()) return { ok: false, motivo: 'recurrente_no_configurado' };

  try {
    const checkout = await crearCheckoutComision({
      leadId,
      usuario: asesor,
      montoQ: lead.comision_inmobia,
      moneda: lead.moneda_cierre || 'GTQ',
      successUrl: `${BASE_URL}/panel-asesor.html?pago=comision-exito`,
      cancelUrl:  `${BASE_URL}/panel-asesor.html?pago=comision-cancelado`,
    });
    const link = checkout.checkout_url || checkout.url || '';
    const ahora = new Date().toISOString();

    db.prepare(`UPDATE leads SET comision_checkout_id = ?, comision_link_pago = ?, comision_link_creado_en = ?, comision_estado = 'pendiente' WHERE id = ?`)
      .run(checkout.id || '', link, ahora, leadId);

    db.prepare(`INSERT INTO pagos (usuario_id, tipo, monto, moneda, estado, recurrente_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(asesor.id, 'comision_cierre', lead.comision_inmobia, lead.moneda_cierre || 'GTQ', 'pendiente', checkout.id || '', JSON.stringify({ checkout, lead_id: leadId }));

    // Email al asesor
    enviarCorreoComisionAsesor({
      email: asesor.email,
      nombreAsesor: asesor.nombre,
      nombreCliente: lead.nombre,
      propiedadTitulo: lead.propiedad_titulo,
      valorCierre: lead.valor_cierre,
      comisionInmobia: lead.comision_inmobia,
      moneda: lead.moneda_cierre || 'GTQ',
      linkPago: link,
      diasPlazo: 5,
    }).then(r => {
      if (r.ok) console.log('📧 Correo cobro comisión enviado a', asesor.email);
    });

    // Link wa.me para que el asesor (o un operador) pueda compartir el cobro por WhatsApp
    const simbolo = (lead.moneda_cierre || 'GTQ') === 'USD' ? '$' : 'Q';
    const mensajeWA = `Hola ${asesor.nombre || ''}, tu cliente ${lead.nombre || ''} confirmó el cierre de *${lead.propiedad_titulo || 'la propiedad'}*. ` +
      `Tu comisión InmobIA es de ${simbolo}${Number(lead.comision_inmobia).toLocaleString('es-GT')}. ` +
      `Pagarla aquí: ${link}`;
    const whatsappLink = buildWhatsAppLink({ telefono: asesor.telefono, mensaje: mensajeWA });

    return { ok: true, link, whatsapp: whatsappLink, checkout_id: checkout.id || '' };
  } catch (err) {
    console.error('❌ Error generando cobro comisión lead', leadId, err.message, err.data || '');
    return { ok: false, motivo: 'recurrente_error', detalle: err.message };
  }
}

// Genera token único de 32 bytes
function generarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── POST /api/cliente/magic-link  (pública — enviado desde contactos al agendar)
// Crea un magic link para el email del cliente y lo devuelve (el caller envía el email)
router.post('/magic-link', (req, res) => {
  const { email, lead_id } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  const token = generarToken();
  // Expira en 30 días
  const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO magic_links (token, email, lead_id, expira_en)
    VALUES (?, ?, ?, ?)
  `).run(token, email.toLowerCase().trim(), lead_id || null, expira);

  const link = `${process.env.BASE_URL || 'http://localhost:5500'}/panel-cliente.html?token=${token}`;
  res.json({ token, link });
});

// ── GET /api/cliente/verify/:token  (pública — verifica token y devuelve datos del cliente)
router.get('/verify/:token', (req, res) => {
  const ml = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(req.params.token);

  if (!ml) return res.status(404).json({ error: 'Link inválido o expirado' });
  if (new Date(ml.expira_en) < new Date()) return res.status(401).json({ error: 'El link ha expirado' });

  // Auto-renovar según tipo de operación del lead
  const leadProp = ml.lead_id
    ? db.prepare('SELECT p.operacion FROM leads l LEFT JOIN propiedades p ON p.id = l.propiedad_id WHERE l.id = ?').get(ml.lead_id)
    : null;
  const esRenta      = leadProp?.operacion === 'renta';
  const diasRenovar  = esRenta ? 30 : 60; // renta: 30 días · compra/venta: 60 días
  const nuevaExpira  = new Date(Date.now() + diasRenovar * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE magic_links SET expira_en = ? WHERE token = ?').run(nuevaExpira, ml.token);

  // Solo los leads que pasaron por el flujo del cliente (tienen magic link asociado)
  // Esto garantiza que cada cliente ve únicamente SUS agendamientos, no datos de otros
  const leadsIds = db.prepare(
    `SELECT DISTINCT lead_id FROM magic_links WHERE LOWER(email) = ? AND lead_id IS NOT NULL`
  ).all(ml.email.toLowerCase()).map(r => r.lead_id);

  const leads = leadsIds.length ? db.prepare(`
    SELECT l.*,
      u.nombre AS asesor_nombre, u.telefono AS asesor_telefono,
      u.foto AS asesor_foto, u.slug AS asesor_slug, u.empresa AS asesor_empresa,
      (SELECT url FROM imagenes WHERE propiedad_id = l.propiedad_id AND principal = 1 LIMIT 1) AS prop_imagen,
      p.precio AS prop_precio, p.moneda AS prop_moneda, p.zona AS prop_zona,
      p.municipio AS prop_municipio, p.tipo AS prop_tipo, p.operacion AS prop_operacion,
      p.habitaciones AS prop_hab, p.banos AS prop_banos, p.metros AS prop_metros,
      p.nombre_proyecto AS prop_proyecto, p.colonia AS prop_colonia,
      c.estrellas AS calificacion_estrellas, c.razones AS calificacion_razones,
      c.comentario AS calificacion_comentario
    FROM leads l
    LEFT JOIN usuarios u ON u.id = l.asesor_id
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    LEFT JOIN calificaciones c ON c.lead_id = l.id
    WHERE l.id IN (${leadsIds.map(() => '?').join(',')})
    ORDER BY l.creado_en DESC
  `).all(...leadsIds) : [];

  res.json({
    email: ml.email,
    leads,
    magic_lead_id: ml.lead_id,
    total_visitas: leads.filter(l => l.etapa !== 'nuevo').length
  });
});

// ── GET /api/cliente/propiedades-sugeridas  (pública con email — propiedades para el feed)
router.get('/propiedades-sugeridas', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  // Tomar el último lead del cliente para inferir preferencias
  const ultimoLead = db.prepare(`
    SELECT l.*, p.tipo AS p_tipo, p.operacion AS p_op, p.zona AS p_zona, p.municipio AS p_municipio,
           p.precio AS p_precio, p.habitaciones AS p_hab
    FROM leads l
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE LOWER(l.email) = ?
    ORDER BY l.creado_en DESC LIMIT 1
  `).get(email.toLowerCase().trim());

  // IDs de propiedades que el cliente ya tiene en sus leads (excluir del feed)
  const propIdsVisitadas = db.prepare(
    `SELECT DISTINCT propiedad_id FROM leads WHERE LOWER(email) = ? AND propiedad_id IS NOT NULL`
  ).all(email.toLowerCase().trim()).map(r => r.propiedad_id);

  let sql = `
    SELECT p.*,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
      u.nombre AS asesor_nombre, u.slug AS asesor_slug
    FROM propiedades p
    LEFT JOIN usuarios u ON u.id = p.usuario_id
    WHERE p.publicado_inmobia = 1 AND p.estado IN ('activo','pendiente')
  `;
  const params = [];

  // Excluir propiedades ya visitadas/agendadas por este cliente
  if (propIdsVisitadas.length) {
    sql += ` AND p.id NOT IN (${propIdsVisitadas.map(() => '?').join(',')})`;
    params.push(...propIdsVisitadas);
  }

  if (ultimoLead) {
    if (ultimoLead.p_tipo)  { sql += ' AND p.tipo = ?';       params.push(ultimoLead.p_tipo); }
    if (ultimoLead.p_op)    { sql += ' AND p.operacion = ?';  params.push(ultimoLead.p_op); }
    if (ultimoLead.p_precio){ sql += ' AND p.precio <= ?';    params.push(ultimoLead.p_precio * 1.3); }
  }

  sql += ' ORDER BY p.creado_en DESC LIMIT 12';

  const propiedades = db.prepare(sql).all(...params);
  res.json({ propiedades, preferencias: ultimoLead ? { tipo: ultimoLead.p_tipo, operacion: ultimoLead.p_op } : null });
});

// ── POST /api/cliente/calificar  (pública — cliente califica al asesor)
router.post('/calificar', (req, res) => {
  const { token, lead_id, estrellas, razones, comentario } = req.body;

  if (!token || !lead_id || !estrellas)
    return res.status(400).json({ error: 'Datos incompletos' });

  // Verificar que el token pertenece a este lead
  const ml = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(token);
  if (!ml) return res.status(403).json({ error: 'No autorizado' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND LOWER(email) = ?').get(lead_id, ml.email);
  if (!lead) return res.status(403).json({ error: 'Lead no encontrado' });

  // Insertar o actualizar calificación
  db.prepare(`
    INSERT INTO calificaciones (lead_id, asesor_id, estrellas, razones, comentario)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      estrellas = excluded.estrellas,
      razones = excluded.razones,
      comentario = excluded.comentario
  `).run(lead_id, lead.asesor_id, Number(estrellas),
    Array.isArray(razones) ? razones.join(',') : (razones || ''),
    comentario || '');

  // Actualizar calificacion_cliente en el lead
  db.prepare('UPDATE leads SET calificacion_cliente = ? WHERE id = ?').run(Number(estrellas), lead_id);

  // Sumar score al asesor según estrellas (+0.8 si 5★, +0.3 si 4★)
  const stars = Number(estrellas);
  const scoreDelta = stars === 5 ? 0.8 : stars === 4 ? 0.3 : 0;
  if (scoreDelta > 0) {
    db.prepare('UPDATE usuarios SET score = MIN(5.0, MAX(1.0, ROUND(score + ?, 2))) WHERE id = ?')
      .run(scoreDelta, lead.asesor_id);
  }

  res.json({ ok: true });
});

// Helper: valida token + pertenencia del lead al cliente
function validarTokenLead(token, leadId) {
  if (!token || !leadId) return { ok: false, error: 'Datos incompletos', code: 400 };
  const ml = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(token);
  if (!ml) return { ok: false, error: 'No autorizado', code: 403 };
  if (new Date(ml.expira_en) < new Date()) return { ok: false, error: 'Link expirado', code: 401 };
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND LOWER(email) = ?').get(Number(leadId), ml.email);
  if (!lead) return { ok: false, error: 'Lead no encontrado', code: 403 };
  return { ok: true, lead, ml };
}

// ── POST /api/cliente/confirmar-visita  (cliente confirma que asistirá a la visita 5RA)
router.post('/confirmar-visita', (req, res) => {
  const { token, lead_id } = req.body;
  const v = validarTokenLead(token, lead_id);
  if (!v.ok) return res.status(v.code).json({ error: v.error });
  const { lead } = v;

  if (lead.visita_cliente_confirmada_en) {
    return res.json({ ok: true, ya_confirmado: true });
  }
  if (!lead.visita_coordinada_en) {
    return res.status(409).json({ error: 'No hay visita programada para confirmar' });
  }

  const ahora = new Date().toISOString();
  db.prepare('UPDATE leads SET visita_cliente_confirmada_en = ? WHERE id = ?').run(ahora, lead.id);
  db.prepare('INSERT INTO lead_bitacora (lead_id, tipo, nota) VALUES (?,?,?)')
    .run(lead.id, 'auto-etapa', 'Cliente confirmó asistencia a la visita');

  res.json({ ok: true, confirmado_en: ahora });
});

// ── POST /api/cliente/confirmar-cierre  (cliente valida que el cierre ocurrió)
router.post('/confirmar-cierre', async (req, res) => {
  const { token, lead_id, observacion } = req.body;
  const v = validarTokenLead(token, lead_id);
  if (!v.ok) return res.status(v.code).json({ error: v.error });
  const { lead } = v;

  if (lead.cierre_verificacion_estado === 'confirmado') {
    return res.json({ ok: true, ya_confirmado: true });
  }
  if (!lead.cierre_declarado_en) {
    return res.status(409).json({ error: 'Este cierre aún no ha sido declarado por el asesor' });
  }

  const ahora = new Date().toISOString();
  const obs = (observacion || '').trim().slice(0, 1000) || null;
  db.prepare(`UPDATE leads SET cierre_verificacion_estado = 'confirmado', cierre_verificado_en = ?, cierre_cliente_observacion = ? WHERE id = ?`)
    .run(ahora, obs, lead.id);

  // Disparar generación del cobro de comisión (email + wa.me) — no bloquea la respuesta al cliente
  const cobro = await generarCobroComision(lead.id);

  res.json({ ok: true, verificado_en: ahora, cobro });
});

// ── POST /api/cliente/disputar-cierre  (cliente dice que NO cerró — alerta al sistema)
router.post('/disputar-cierre', (req, res) => {
  const { token, lead_id, motivo, observacion } = req.body;
  const v = validarTokenLead(token, lead_id);
  if (!v.ok) return res.status(v.code).json({ error: v.error });
  const { lead } = v;

  const ahora = new Date().toISOString();
  const obs = (observacion || '').trim().slice(0, 1000) || null;
  db.prepare(`UPDATE leads SET cierre_verificacion_estado = 'disputado', cierre_verificado_en = ?, cierre_disputa_motivo = ?, cierre_cliente_observacion = ? WHERE id = ?`)
    .run(ahora, (motivo || '').slice(0, 500), obs, lead.id);

  console.warn(`🚨 Cliente disputó cierre de lead ${lead.id} (asesor ${lead.asesor_id}) — motivo: ${motivo || '—'}`);

  res.json({ ok: true, disputado_en: ahora });
});

export default router;
