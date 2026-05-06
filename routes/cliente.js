import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { crearCheckoutComision, keysConfigured } from '../lib/recurrente.js';
import { propiedadEsDeAdmin } from '../lib/modelos.js';
import { enviarCorreoComisionAsesor, enviarCorreoCierreConfirmado1D, enviarEmailBusquedaCliente, enviarEmailNuevoLeadBusqueda, enviarEmailAdminLeadInmobia } from '../email.js';
import { sendWhatsApp } from '../whatsapp.js';

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

  // Leads del cliente: los vinculados por magic link + todos sus leads de búsqueda personalizada
  const leadsFromMagicLink = db.prepare(
    `SELECT DISTINCT lead_id FROM magic_links WHERE LOWER(email) = ? AND lead_id IS NOT NULL`
  ).all(ml.email.toLowerCase()).map(r => r.lead_id);

  const leadsFromBusqueda = db.prepare(
    `SELECT id FROM leads WHERE LOWER(email) = ? AND origen = 'busqueda_personalizada'`
  ).all(ml.email.toLowerCase()).map(r => r.id);

  const leadsIds = [...new Set([...leadsFromMagicLink, ...leadsFromBusqueda])];

  const leads = leadsIds.length ? db.prepare(`
    SELECT l.*,
      u.nombre AS asesor_nombre,
      u.foto AS asesor_foto, u.slug AS asesor_slug, u.empresa AS asesor_empresa,
      (SELECT url FROM imagenes WHERE propiedad_id = l.propiedad_id AND principal = 1 LIMIT 1) AS prop_imagen,
      p.precio AS prop_precio, p.moneda AS prop_moneda, p.zona AS prop_zona,
      p.municipio AS prop_municipio, p.tipo AS prop_tipo, p.operacion AS prop_operacion,
      p.habitaciones AS prop_hab, p.banos AS prop_banos, p.metros AS prop_metros,
      p.nombre_proyecto AS prop_proyecto, p.colonia AS prop_colonia,
      c.estrellas AS calificacion_estrellas, c.razones AS calificacion_razones,
      c.comentario AS calificacion_comentario, c.interes AS calificacion_interes,
      c.asesor_estrellas AS cal_asesor_estrellas, c.asesor_razones AS cal_asesor_razones,
      c.asesor_comentario AS cal_asesor_comentario, c.recomendaria AS cal_recomendaria
    FROM leads l
    LEFT JOIN usuarios u ON u.id = l.asesor_id
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    LEFT JOIN calificaciones c ON c.lead_id = l.id
    WHERE l.id IN (${leadsIds.map(() => '?').join(',')})
    ORDER BY l.creado_en DESC
  `).all(...leadsIds) : [];

  const waSetting = db.prepare("SELECT valor FROM platform_settings WHERE clave = 'wa_consultas'").get();
  const waInmobia = waSetting?.valor || '50239600421';

  res.json({
    email: ml.email,
    leads,
    magic_lead_id: ml.lead_id,
    total_visitas: leads.filter(l => l.etapa !== 'nuevo').length,
    wa_inmobia: waInmobia
  });
});

// ── GET /api/cliente/propiedades-sugeridas  (pública con email)
router.get('/propiedades-sugeridas', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  const emailLower = email.toLowerCase().trim();

  // Preferencias guardadas por el cliente (prioridad 1)
  const perfilGuardado = db.prepare('SELECT * FROM perfiles_cliente WHERE LOWER(email) = ?').get(emailLower);

  // Último lead como fallback (prioridad 2)
  const ultimoLead = db.prepare(`
    SELECT l.*, p.tipo AS p_tipo, p.operacion AS p_op, p.zona AS p_zona,
           p.precio AS p_precio, p.habitaciones AS p_hab
    FROM leads l
    LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE LOWER(l.email) = ?
    ORDER BY l.creado_en DESC LIMIT 1
  `).get(emailLower);

  // Preferencias efectivas (perfil > lead > nada)
  const pref = perfilGuardado || (ultimoLead ? {
    tipo: ultimoLead.p_tipo, operacion: ultimoLead.p_op,
    presupuesto_max: ultimoLead.p_precio ? ultimoLead.p_precio * 1.3 : null,
    habitaciones_min: 0, acepta_mascotas: 0, zonas: ''
  } : null);

  // IDs de propiedades ya en leads del cliente (excluir del feed)
  const propIdsVisitadas = db.prepare(
    `SELECT DISTINCT propiedad_id FROM leads WHERE LOWER(email) = ? AND propiedad_id IS NOT NULL`
  ).all(emailLower).map(r => r.propiedad_id);

  // Parsear zonas: "Zona 10, Miraflores, Santa Catarina Pinula" → ['zona 10','miraflores','santa catarina pinula']
  const zonasTokens = (pref?.zonas || '')
    .split(',').map(z => z.trim().toLowerCase()).filter(Boolean);

  // Parsear tipos: "casa,apartamento" → ['casa','apartamento']
  const tiposArray = (pref?.tipo || '').split(',').map(t => t.trim()).filter(Boolean);

  // Helper para construir la query con filtros aplicados
  function buildQuery({ tipos, operacion, presupuesto, habMin, zonas, excluirIds, limit }) {
    let q = `
      SELECT p.*,
        (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
        u.nombre AS asesor_nombre, u.slug AS asesor_slug
      FROM propiedades p
      LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.publicado_inmobia = 1 AND p.estado IN ('activo','pendiente')
    `;
    const p = [];

    if (excluirIds.length) {
      q += ` AND p.id NOT IN (${excluirIds.map(() => '?').join(',')})`;
      p.push(...excluirIds);
    }
    // Tipo: IN para multi-select
    if (tipos && tipos.length) {
      q += ` AND p.tipo IN (${tipos.map(() => '?').join(',')})`;
      p.push(...tipos);
    }
    if (operacion)  { q += ' AND p.operacion = ?';  p.push(operacion); }
    if (presupuesto){ q += ' AND p.precio <= ?';    p.push(presupuesto); }
    if (habMin > 0) { q += ' AND p.habitaciones >= ?'; p.push(habMin); }

    // Zona: OR entre tokens contra municipio, zona y colonia
    if (zonas.length) {
      const conds = zonas.map(() =>
        '(LOWER(COALESCE(p.municipio,"")) LIKE ? OR LOWER(COALESCE(p.zona,"")) LIKE ? OR LOWER(COALESCE(p.colonia,"")) LIKE ?)'
      ).join(' OR ');
      q += ` AND (${conds})`;
      zonas.forEach(z => p.push(`%${z}%`, `%${z}%`, `%${z}%`));
    }

    q += ` ORDER BY p.creado_en DESC LIMIT ${parseInt(limit)}`;
    return { q, p };
  }

  // Filtros duros: todos los criterios del perfil
  const { q: qDuro, p: pDuro } = buildQuery({
    tipos: tiposArray,
    operacion: pref?.operacion || null,
    presupuesto: pref?.presupuesto_max || null,
    habMin: pref?.habitaciones_min || 0,
    zonas: zonasTokens,
    excluirIds: propIdsVisitadas,
    limit: 18
  });
  let propiedades = db.prepare(qDuro).all(...pDuro);

  // Relleno escalonado si hay pocos resultados — relajar filtros de a uno
  if (pref && propiedades.length < 6) {
    // Ronda 2: quitar filtro de habitaciones
    const idsYa2 = propiedades.map(p => p.id).concat(propIdsVisitadas);
    if (propiedades.length < 6) {
      const { q: q2, p: p2 } = buildQuery({
        tipos: tiposArray, operacion: pref?.operacion || null,
        presupuesto: pref?.presupuesto_max || null,
        habMin: 0, zonas: zonasTokens,
        excluirIds: idsYa2, limit: 6 - propiedades.length
      });
      propiedades = [...propiedades, ...db.prepare(q2).all(...p2)];
    }

    // Ronda 3: quitar zona también
    const idsYa3 = propiedades.map(p => p.id).concat(propIdsVisitadas);
    if (propiedades.length < 6) {
      const { q: q3, p: p3 } = buildQuery({
        tipos: tiposArray, operacion: pref?.operacion || null,
        presupuesto: pref?.presupuesto_max ? pref.presupuesto_max * 1.3 : null,
        habMin: 0, zonas: [],
        excluirIds: idsYa3, limit: 6 - propiedades.length
      });
      propiedades = [...propiedades, ...db.prepare(q3).all(...p3)];
    }

    // Ronda 4: solo operación — sin tipo, zona, hab ni presupuesto
    const idsYa4 = propiedades.map(p => p.id).concat(propIdsVisitadas);
    if (propiedades.length < 4) {
      const { q: q4, p: p4 } = buildQuery({
        tipos: [], operacion: pref?.operacion || null, presupuesto: null,
        habMin: 0, zonas: [],
        excluirIds: idsYa4, limit: 12 - propiedades.length
      });
      propiedades = [...propiedades, ...db.prepare(q4).all(...p4)];
    }
  }

  res.json({ propiedades, preferencias: pref });
});

// ── POST /api/cliente/calificar  (pública — cliente califica al asesor)
router.post('/calificar', (req, res) => {
  const {
    token, lead_id, estrellas, razones, comentario,
    interes, asesor_estrellas, asesor_razones, asesor_comentario, recomendaria
  } = req.body;

  if (!token || !lead_id || !estrellas)
    return res.status(400).json({ error: 'Datos incompletos' });

  const ml = db.prepare('SELECT * FROM magic_links WHERE token = ?').get(token);
  if (!ml) return res.status(403).json({ error: 'No autorizado' });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND LOWER(email) = ?').get(lead_id, ml.email);
  if (!lead) return res.status(403).json({ error: 'Lead no encontrado' });

  const propRazones  = Array.isArray(razones)       ? razones.join(',')       : (razones || '');
  const asRazones    = Array.isArray(asesor_razones) ? asesor_razones.join(',') : (asesor_razones || '');
  const asEstrellas  = asesor_estrellas ? Number(asesor_estrellas) : null;

  db.prepare(`
    INSERT INTO calificaciones
      (lead_id, asesor_id, estrellas, razones, comentario, interes, asesor_estrellas, asesor_razones, asesor_comentario, recomendaria)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      estrellas        = excluded.estrellas,
      razones          = excluded.razones,
      comentario       = excluded.comentario,
      interes          = excluded.interes,
      asesor_estrellas = excluded.asesor_estrellas,
      asesor_razones   = excluded.asesor_razones,
      asesor_comentario= excluded.asesor_comentario,
      recomendaria     = excluded.recomendaria
  `).run(lead_id, lead.asesor_id, Number(estrellas),
    propRazones, comentario || '', interes || '',
    asEstrellas, asRazones, asesor_comentario || '', recomendaria || '');

  db.prepare('UPDATE leads SET calificacion_cliente = ? WHERE id = ?').run(Number(estrellas), lead_id);

  // Score asesor: estrellas de la propiedad + estrellas del servicio del asesor
  const propStars = Number(estrellas);
  const asStars   = asEstrellas || 0;
  const propDelta = propStars === 5 ? 0.4 : propStars === 4 ? 0.15 : 0;
  const asDelta   = asStars   === 5 ? 0.4 : asStars   === 4 ? 0.15 : asStars <= 2 ? -0.3 : 0;
  const totalDelta = propDelta + asDelta;
  if (totalDelta !== 0) {
    db.prepare('UPDATE usuarios SET score = MIN(5.0, MAX(0.0, ROUND(score + ?, 2))) WHERE id = ?')
      .run(totalDelta, lead.asesor_id);
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

// ── GET /api/cliente/busqueda  — perfil de búsqueda del cliente
// ── GET /api/cliente/busquedas-admin  (admin — panel de búsquedas personalizadas)
router.get('/busquedas-admin', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const busquedas = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM leads l
       WHERE l.origen = 'busqueda_personalizada' AND l.email = r.cliente_email
         AND datetime(l.creado_en) >= datetime(r.creado_en, '-10 minutes')
      ) AS total_leads,
      (SELECT MAX(
        CASE l.etapa
          WHEN 'cerrado'     THEN 6
          WHEN 'negociando'  THEN 5
          WHEN 'agendado'    THEN 4
          WHEN 'interesado'  THEN 3
          WHEN 'nuevo'       THEN 2
          ELSE 1 END)
       FROM leads l
       WHERE l.origen = 'busqueda_personalizada' AND l.email = r.cliente_email
         AND datetime(l.creado_en) >= datetime(r.creado_en, '-10 minutes')
      ) AS etapa_max_num,
      (SELECT MAX(l.actualizado_en)
       FROM leads l
       WHERE l.origen = 'busqueda_personalizada' AND l.email = r.cliente_email
         AND datetime(l.creado_en) >= datetime(r.creado_en, '-10 minutes')
      ) AS ultima_actividad
    FROM requerimientos r
    WHERE r.fuente = 'cliente'
    ORDER BY r.creado_en DESC
  `).all();
  res.json({ busquedas, total: busquedas.length });
});

// ── GET /api/cliente/busquedas-admin/:id/leads  (admin — ficha completa de una búsqueda)
router.get('/busquedas-admin/:id/leads', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const req_ = db.prepare('SELECT * FROM requerimientos WHERE id = ? AND fuente = ?').get(req.params.id, 'cliente');
  if (!req_) return res.status(404).json({ error: 'No encontrado' });
  const leads = db.prepare(`
    SELECT l.*,
      u.nombre as asesor_nombre, u.email as asesor_email,
      u.telefono as asesor_telefono, u.codigo_asesor as asesor_codigo,
      (SELECT url FROM imagenes WHERE propiedad_id = l.propiedad_id AND principal = 1 LIMIT 1) AS propiedad_imagen
    FROM leads l
    JOIN usuarios u ON u.id = l.asesor_id
    WHERE l.origen = 'busqueda_personalizada' AND l.email = ?
      AND datetime(l.creado_en) >= datetime(?, '-10 minutes')
    ORDER BY
      CASE l.etapa WHEN 'cerrado' THEN 1 WHEN 'negociando' THEN 2
        WHEN 'agendado' THEN 3 WHEN 'interesado' THEN 4 ELSE 5 END,
      l.actualizado_en DESC
  `).all(req_.cliente_email, req_.creado_en);

  const leadIds = leads.map(l => l.id);
  const bitacora = leadIds.length ? db.prepare(`
    SELECT b.lead_id, b.tipo, b.nota, b.creado_en, u.nombre as autor
    FROM lead_bitacora b LEFT JOIN usuarios u ON u.id = b.asesor_id
    WHERE b.lead_id IN (${leadIds.map(() => '?').join(',')})
    ORDER BY b.creado_en ASC
  `).all(...leadIds) : [];

  const bitMap = {};
  bitacora.forEach(e => { if (!bitMap[e.lead_id]) bitMap[e.lead_id] = []; bitMap[e.lead_id].push(e); });

  res.json({
    requerimiento: req_,
    leads: leads.map(l => ({ ...l, bitacora: bitMap[l.id] || [] })),
  });
});

router.get('/busqueda', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  const ml = db.prepare('SELECT email FROM magic_links WHERE token = ?').get(token);
  if (!ml) return res.status(403).json({ error: 'Token inválido' });

  const perfil = db.prepare('SELECT * FROM perfiles_cliente WHERE LOWER(email) = ?').get(ml.email.toLowerCase());
  if (!perfil) return res.json({ email: ml.email });

  res.json(perfil);
});

// ── PATCH /api/cliente/busqueda  — actualizar perfil de búsqueda
router.patch('/busqueda', (req, res) => {
  const {
    token, tipo, operacion, presupuesto_max, moneda,
    zonas, habitaciones_min, banos_min,
    acepta_mascotas, acepta_financiamiento, activo_en_red, notas
  } = req.body;

  if (!token) return res.status(400).json({ error: 'Token requerido' });
  const ml = db.prepare('SELECT email, lead_id FROM magic_links WHERE token = ?').get(token);
  if (!ml) return res.status(403).json({ error: 'Token inválido' });

  const email = ml.email.toLowerCase();

  // Obtener nombre del cliente desde su lead más reciente
  const leadCliente = db.prepare(
    `SELECT nombre, telefono FROM leads WHERE LOWER(email) = ? ORDER BY creado_en DESC LIMIT 1`
  ).get(email);

  const existe = db.prepare('SELECT id FROM perfiles_cliente WHERE LOWER(email) = ?').get(email);

  if (existe) {
    db.prepare(`UPDATE perfiles_cliente SET
      tipo = ?, operacion = ?, presupuesto_max = ?, moneda = ?,
      zonas = ?, habitaciones_min = ?, banos_min = ?,
      acepta_mascotas = ?, acepta_financiamiento = ?, activo_en_red = ?,
      notas = ?, actualizado_en = datetime('now')
      WHERE LOWER(email) = ?`).run(
      tipo || '', operacion || '', presupuesto_max || null, moneda || 'GTQ',
      zonas || '', habitaciones_min || 0, banos_min || 0,
      acepta_mascotas ? 1 : 0, acepta_financiamiento ? 1 : 0, activo_en_red ? 1 : 0,
      (notas || '').slice(0, 500), email
    );
  } else {
    db.prepare(`INSERT INTO perfiles_cliente
      (email, tipo, operacion, presupuesto_max, moneda, zonas, habitaciones_min, banos_min,
       acepta_mascotas, acepta_financiamiento, activo_en_red, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      email, tipo || '', operacion || '', presupuesto_max || null, moneda || 'GTQ',
      zonas || '', habitaciones_min || 0, banos_min || 0,
      acepta_mascotas ? 1 : 0, acepta_financiamiento ? 1 : 0, activo_en_red ? 1 : 0,
      (notas || '').slice(0, 500)
    );
  }

  // ── AUTOMATIZACIÓN: publicar en la red de asesores ──────────────
  if (activo_en_red) {
    try {
      // Obtener admin para usar como asesor_id del requerimiento del cliente
      const admin = db.prepare(`SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1`).get();
      if (admin) {
        const vence = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const zonasStr = (zonas || '').slice(0, 200);
        const notasReq = [(notas || '').trim(), acepta_mascotas ? 'Acepta mascotas' : '', acepta_financiamiento ? 'Acepta financiamiento' : ''].filter(Boolean).join(' · ');

        // Crear o reemplazar requerimiento activo del cliente en la red
        const reqExistente = db.prepare(
          `SELECT id FROM requerimientos WHERE cliente_origen_email = ? AND fuente = 'cliente' AND estado = 'activo' LIMIT 1`
        ).get(email);

        if (reqExistente) {
          db.prepare(`UPDATE requerimientos SET
            tipo_propiedad = ?, operacion = ?, precio_max = ?, moneda = ?,
            zona = ?, habitaciones = ?, banos = ?, notas = ?,
            cliente_nombre = ?, cliente_email = ?,
            vence_en = ?, actualizado_en = datetime('now')
            WHERE id = ?`).run(
            tipo || null, operacion || null, presupuesto_max || null, moneda || 'GTQ',
            zonasStr || null, habitaciones_min || null, banos_min || null, notasReq || null,
            leadCliente?.nombre || null, email,
            vence, reqExistente.id
          );
        } else {
          db.prepare(`INSERT INTO requerimientos
            (asesor_id, fuente, cliente_origen_email, cliente_nombre, cliente_email, cliente_telefono,
             tipo_propiedad, operacion, precio_max, moneda, zona, habitaciones, banos, notas,
             estado, vence_en)
            VALUES (?, 'cliente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?)`).run(
            admin.id, email,
            leadCliente?.nombre || null, email, leadCliente?.telefono || null,
            tipo || null, operacion || null, presupuesto_max || null, moneda || 'GTQ',
            zonasStr || null, habitaciones_min || null, banos_min || null, notasReq || null,
            vence
          );
        }

        // Notificar a asesores con propiedades que coinciden
        let sqlMatch = `SELECT DISTINCT u.id, u.nombre FROM propiedades p
          JOIN usuarios u ON u.id = p.usuario_id
          WHERE p.publicado_inmobia = 1 AND p.estado = 'activo'`;
        const params = [];
        if (tipo)      { sqlMatch += ' AND p.tipo = ?';      params.push(tipo); }
        if (operacion) { sqlMatch += ' AND p.operacion = ?'; params.push(operacion); }
        if (presupuesto_max) { sqlMatch += ' AND p.precio <= ?'; params.push(presupuesto_max * 1.2); }

        const asesoresMatch = db.prepare(sqlMatch).all(...params);

        const monedaSim = (moneda || 'GTQ') === 'USD' ? '$' : 'Q';
        const presupuestoStr = presupuesto_max
          ? ` · hasta ${monedaSim}${Number(presupuesto_max).toLocaleString('es-GT')}`
          : '';
        const titulo = `🔍 Cliente InmobIA buscando ${tipo || 'propiedad'} en ${zonasStr || 'Guatemala'}`;
        const mensaje = `Un cliente registrado en InmobIA busca: ${[tipo, operacion, zonasStr].filter(Boolean).join(' · ')}${presupuestoStr}. Si cierras con este cliente, aplica comisión InmobIA del 30%. Revisa si tienes una propiedad que encaje.`;

        const insertNotif = db.prepare(`INSERT INTO notificaciones
          (usuario_id, tipo, titulo, mensaje) VALUES (?, 'requerimiento_cliente', ?, ?)`);
        for (const asesor of asesoresMatch) {
          insertNotif.run(asesor.id, titulo, mensaje);
        }

        console.log(`[Red] Requerimiento de cliente ${email} publicado → ${asesoresMatch.length} asesores notificados`);
      }
    } catch(e) {
      console.error('[Red] Error al publicar requerimiento:', e.message);
    }
  } else {
    // Si desactivó la red, marcar requerimiento como inactivo
    try {
      db.prepare(`UPDATE requerimientos SET estado = 'inactivo' WHERE cliente_origen_email = ? AND fuente = 'cliente'`).run(email);
    } catch {}
  }

  res.json({ ok: true });
});

// ── PATCH /api/cliente/busqueda-publica/:id/detalles  (enriquecimiento — aquí se envían TODAS las notificaciones)
router.patch('/busqueda-publica/:id/detalles', async (req, res) => {
  const { id } = req.params;
  const { presupuesto_max, habitaciones, banos, parqueos, metros, caracteristicas, mascota, desc_mascota, descripcion } = req.body;

  const req_ = db.prepare('SELECT * FROM requerimientos WHERE id = ? AND fuente = ?').get(id, 'cliente');
  if (!req_) return res.status(404).json({ error: 'Requerimiento no encontrado' });

  const notasArr = [
    req_.notas || '',
    mascota ? `Mascota: ${mascota}${desc_mascota ? ' — ' + desc_mascota : ''}` : '',
    descripcion || '',
  ].filter(Boolean);

  db.prepare(`
    UPDATE requerimientos SET
      precio_max = ?, habitaciones = ?, banos = ?, metros_min = ?,
      caracteristicas = ?, notas = ?, actualizado_en = datetime('now')
    WHERE id = ?
  `).run(
    presupuesto_max ? Number(presupuesto_max) : req_.precio_max,
    habitaciones    ? Number(habitaciones)    : req_.habitaciones,
    banos           ? Number(banos)           : req_.banos,
    metros          ? Number(metros)          : req_.metros_min,
    caracteristicas || req_.caracteristicas,
    notasArr.join('\n') || req_.notas,
    id,
  );

  const hab     = habitaciones ? Number(habitaciones) : req_.habitaciones;
  const ban     = banos        ? Number(banos)        : req_.banos;
  const parq    = parqueos;
  const tipo    = req_.tipo_propiedad;
  const oper    = req_.operacion;
  const zona    = req_.zona || req_.municipio || 'Guatemala';
  const presup  = presupuesto_max ? Number(presupuesto_max) : req_.precio_max;
  const monedaSim = (req_.moneda || 'GTQ') === 'USD' ? '$' : 'Q';
  const presupTexto = presup ? `${monedaSim}${Number(presup).toLocaleString('es-GT')}` : null;
  const BASE_URL_  = process.env.BASE_URL || 'https://inmobia.site';

  const detalles = [
    hab   ? `${hab} hab.` : '',
    ban   ? `${ban} baños` : '',
    parq  ? parq : '',
    metros ? `${metros} m²+` : '',
    caracteristicas ? caracteristicas.split(',').slice(0,3).join(', ') : '',
  ].filter(Boolean).join(' · ');

  const tituloNotif = `🔍 Nuevo cliente de búsqueda personalizada — ${tipo} en ${zona}`;
  const mensajeNotif = `${req_.cliente_nombre || 'Cliente'} completó su perfil: ${tipo} para ${oper} en ${zona}${presupTexto ? ` · hasta ${presupTexto}` : ''}${detalles ? ` · ${detalles}` : ''}. Revise si tiene una propiedad que encaje mejor.`;

  // 1. Enviar email + WA a asesores que ya tienen el lead
  // Solo asesores externos (no admin/InmobIA) — los leads 1D los gestiona InmobIA directamente
  const adminUser = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
  const leadsOriginales = db.prepare(
    `SELECT l.asesor_id, u.nombre, u.email, u.telefono, MIN(l.id) as lead_id
     FROM leads l JOIN usuarios u ON u.id = l.asesor_id
     WHERE l.origen = 'busqueda_personalizada' AND l.email = ?
       AND datetime(l.creado_en) >= datetime(?, '-15 minutes')
       AND (l.modelo IS NULL OR l.modelo != '1D')
       AND u.rol != 'admin'
     GROUP BY l.asesor_id, u.nombre, u.email, u.telefono`
  ).all(req_.cliente_email || '', req_.creado_en);

  const insertNotif = db.prepare(`INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, referencia_id) VALUES (?, 'lead_busqueda', ?, ?, ?)`);

  for (const a of leadsOriginales) {
    insertNotif.run(a.asesor_id, tituloNotif, mensajeNotif, a.lead_id || null);
    if (a.email) {
      let propData = null;
      if (a.lead_id) {
        const lRow = db.prepare(`
          SELECT l.propiedad_titulo, p.precio, p.zona, p.moneda,
                 (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) as img
          FROM leads l LEFT JOIN propiedades p ON p.id = l.propiedad_id
          WHERE l.id = ?
        `).get(a.lead_id);
        if (lRow) propData = { titulo: lRow.propiedad_titulo, precio: lRow.precio, zona: lRow.zona, moneda: lRow.moneda, img: lRow.img };
      }
      enviarEmailNuevoLeadBusqueda({
        email: a.email, nombreAsesor: a.nombre,
        cliente: req_.cliente_nombre, tipo, operacion: oper, zona,
        presupuesto: presupTexto, detalles: detalles || null,
        propiedad: propData,
        linkCRM: `${BASE_URL_}/panel-asesor.html?lead=${a.lead_id}`,
      }).catch(() => {});
    }
    if (a.telefono) {
      const msgAsesor = `🔍 *Nuevo cliente de búsqueda personalizada — ${tipo} en ${zona}*\n\n*${req_.cliente_nombre}* busca: *${tipo}* para *${oper}* en *${zona}*${presupTexto ? `\nPresupuesto: hasta *${presupTexto}*` : ''}${detalles ? `\nDetalles: ${detalles}` : ''}\n\nRevise el lead en su panel:\n${BASE_URL_}/panel-asesor.html#crm`;
      sendWhatsApp(a.telefono, msgAsesor).catch(e => console.error('[WA asesor busqueda]', e.message));
    }
  }

  // 1B. Email al admin para leads 1D (propiedades InmobIA)
  const leadsAdmin = db.prepare(`
    SELECT l.propiedad_titulo as titulo, p.precio, p.zona, p.moneda,
           (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) as img
    FROM leads l LEFT JOIN propiedades p ON p.id = l.propiedad_id
    WHERE l.origen = 'busqueda_personalizada' AND l.email = ?
      AND l.modelo = '1D'
      AND datetime(l.creado_en) >= datetime(?, '-15 minutes')
    LIMIT 4
  `).all(req_.cliente_email || '', req_.creado_en);

  if (leadsAdmin.length > 0) {
    const adminUser = db.prepare("SELECT id, email, nombre, telefono FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
    if (adminUser) {
      // Notificación en panel admin
      db.prepare(`INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, referencia_id)
        VALUES (?, 'lead_busqueda_1d', ?, ?, ?)`).run(
        adminUser.id,
        `🔍 Nuevo lead InmobIA — ${tipo} en ${zona}`,
        `${req_.cliente_nombre || 'Cliente'} busca ${tipo} para ${oper} en ${zona}${presupTexto ? ` · hasta ${presupTexto}` : ''}. Lead asignado a InmobIA para seguimiento directo.`,
        Number(id)
      );

      // Email al admin
      if (adminUser.email) {
        enviarEmailAdminLeadInmobia({
          email: adminUser.email, nombreAdmin: adminUser.nombre,
          cliente: req_.cliente_nombre, tipo, operacion: oper, zona,
          presupuesto: presupTexto, detalles: detalles || null,
          propiedades: leadsAdmin,
          linkAdmin: `${BASE_URL_}/admin.html?busqueda=${id}`,
        }).catch(() => {});
      }

      // WA al admin (número configurado en platform_settings.wa_consultas)
      const waSetting = db.prepare("SELECT valor FROM platform_settings WHERE clave = 'wa_consultas'").get();
      const waAdmin = waSetting?.valor || adminUser.telefono;
      if (waAdmin) {
        const msgAdmin = `🔍 *Nuevo lead InmobIA*\n\n*${req_.cliente_nombre || 'Cliente'}* completó su perfil y busca:\n*${tipo}* · ${oper} · ${zona}${presupTexto ? `\nPresupuesto: hasta *${presupTexto}*` : ''}${detalles ? `\nDetalles: ${detalles}` : ''}\n\nHay *${leadsAdmin.length} propiedad${leadsAdmin.length > 1 ? 'es' : ''} InmobIA* que encajan.\n\nVer en el CRM:\n${BASE_URL_}/admin.html?busqueda=${id}`;
        sendWhatsApp(waAdmin, msgAdmin).catch(e => console.error('[WA admin 1D]', e.message));
      }
    }
  }

  // 2. Si no había leads (sin match inicial), notificar a asesores activos ahora con perfil completo
  if (leadsOriginales.length === 0) {
    const activos = db.prepare(`
      SELECT DISTINCT u.id as asesor_id, u.nombre, u.email, u.telefono
      FROM propiedades p JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.publicado_inmobia = 1 AND p.estado = 'activo'
        AND u.rol != 'admin'
      LIMIT 60
    `).all();
    for (const a of activos) {
      insertNotif.run(a.asesor_id, tituloNotif, mensajeNotif, null);
      if (a.email) {
        enviarEmailNuevoLeadBusqueda({
          email: a.email, nombreAsesor: a.nombre,
          cliente: req_.cliente_nombre, tipo, operacion: oper, zona,
          presupuesto: presupTexto,
          detalles: detalles || null,
          linkCRM: `${BASE_URL_}/panel-asesor.html#crm`,
        }).catch(() => {});
      }
      if (a.telefono) {
        sendWhatsApp(a.telefono, `🔍 *Requerimiento InmobIA — Perfil completo*\n\nCliente busca: *${tipo}* para *${oper}* en *${zona}*${presupTexto ? `\nHasta: *${presupTexto}*` : ''}${detalles ? `\nDetalles: ${detalles}` : ''}\n\nSi tiene una propiedad que encaje:\n${BASE_URL_}/panel-asesor.html#crm`).catch(() => {});
      }
    }
  }

  // 3. Magic link + WA al cliente (primero) + email (al final, no bloqueante)
  const clienteEmail = req_.cliente_email || req_.cliente_origen_email;
  const clienteTel   = req_.cliente_telefono;
  let linkPanel = null;
  let totalLeads = leadsOriginales.length || 0;
  console.log(`[busqueda-detalles] req=${id} email=${clienteEmail} tel=${clienteTel} leads=${totalLeads}`);

  if (clienteEmail) {
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const leadReciente = db.prepare(
      `SELECT id FROM leads WHERE origen = 'busqueda_personalizada' AND email = ?
       AND datetime(creado_en) >= datetime(?, '-15 minutes')
       ORDER BY creado_en DESC LIMIT 1`
    ).get(clienteEmail, req_.creado_en);
    db.prepare(`INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)`)
      .run(token, clienteEmail.toLowerCase().trim(), leadReciente?.id || null, expira);
    linkPanel = `${BASE_URL_}/panel-cliente.html?token=${token}`;

    // ── WA al cliente PRIMERO (no espera email para evitar bloqueo por Resend) ──
    if (clienteTel) {
      const numLimpio = String(clienteTel).replace(/\D/g, '');
      console.log(`[WA cliente] enviando a tel=${clienteTel} → num=${numLimpio}`);
      const msgCliente = `✅ *¡Búsqueda lista, ${req_.cliente_nombre}!*\n\nSu perfil completo fue enviado a los asesores de nuestra red.\n\n*Búsqueda:* ${tipo} para ${oper} en ${zona}${presupTexto ? `\n*Presupuesto:* hasta ${presupTexto}` : ''}${detalles ? `\n*Detalles:* ${detalles}` : ''}\n\n${totalLeads > 0 ? `Encontramos *${totalLeads} propiedad${totalLeads > 1 ? 'es' : ''}* que pueden encajar. Un asesor le contactará pronto.` : 'Notificamos a nuestra red. Le contactaremos cuando tengamos opciones.'}\n\nSiga su búsqueda:\n${linkPanel}\n\n_Su número y correo son privados._`;
      sendWhatsApp(clienteTel, msgCliente)
        .then(ok => console.log(`[WA cliente] resultado: ${ok ? '✅ enviado' : '❌ fallido'}`))
        .catch(e => console.error('[WA cliente] error:', e.message));
    } else {
      console.warn('[busqueda-detalles] cliente sin telefono — WA omitido');
    }

    // Propiedades para el email del cliente
    const propiedadesEmailCliente = db.prepare(`
      SELECT DISTINCT l.propiedad_titulo as titulo, p.precio, p.zona, p.moneda,
        (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) as img
      FROM leads l LEFT JOIN propiedades p ON p.id = l.propiedad_id
      WHERE l.origen = 'busqueda_personalizada' AND l.email = ?
        AND datetime(l.creado_en) >= datetime(?, '-15 minutes')
        AND p.id IS NOT NULL
      ORDER BY l.id LIMIT 4
    `).all(clienteEmail, req_.creado_en);

    // ── Email al cliente (fire-and-forget, no bloquea la respuesta) ──
    enviarEmailBusquedaCliente({
      email: clienteEmail, nombre: req_.cliente_nombre, tipo, operacion: oper, zona,
      matches: propiedadesEmailCliente.length, propiedades: propiedadesEmailCliente, linkPanel,
    }).catch(e => console.error('[email cliente]', e.message));
  }

  // Retornar linkPanel y propiedades para mostrar al cliente en el frontend
  const propiedadesPreview = db.prepare(`
    SELECT DISTINCT l.propiedad_id, l.propiedad_titulo,
      (SELECT url FROM imagenes WHERE propiedad_id = l.propiedad_id AND principal = 1 LIMIT 1) AS imagen
    FROM leads l
    WHERE l.origen = 'busqueda_personalizada' AND l.email = ?
      AND datetime(l.creado_en) >= datetime(?, '-15 minutes')
    LIMIT 3
  `).all(clienteEmail || '', req_.creado_en);

  res.json({
    ok: true,
    linkPanel,
    propiedades_preview: propiedadesPreview.map(p => ({ titulo: p.propiedad_titulo, imagen: p.imagen || null })),
    matches: leadsOriginales.length,
  });
});

// ── POST /api/cliente/busqueda-publica  (pública — formulario de búsqueda personalizada)
router.post('/busqueda-publica', async (req, res) => {
  const {
    nombre, telefono, email, operacion, tipo,
    departamento, zona, presupuesto_max, moneda,
    habitaciones, banos, parqueos, metros,
    caracteristicas, fecha_mudanza, mascota, desc_mascota, descripcion,
  } = req.body;

  if (!nombre || !telefono || !email || !operacion || !tipo)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  const primerNombre = nombre.trim();
  const lugarStr = zona || departamento || 'Guatemala';
  const presupMax = presupuesto_max ? Number(presupuesto_max) : null;
  const monedaUso = moneda || 'GTQ';

  const notasArr = [
    fecha_mudanza ? `Fecha de mudanza: ${fecha_mudanza}` : '',
    mascota ? `Mascota: ${mascota}${desc_mascota ? ' — ' + desc_mascota : ''}` : '',
    descripcion || '',
  ].filter(Boolean);

  // 1. Obtener admin para asignar el requerimiento
  const admin = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
  if (!admin) return res.status(500).json({ error: 'Sin admin configurado' });

  const vence = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 2. Crear requerimiento con fuente 'cliente'
    const reqResult = db.prepare(`
      INSERT INTO requerimientos
        (asesor_id, fuente, cliente_origen_email, cliente_nombre, cliente_email, cliente_telefono,
         operacion, tipo_propiedad, municipio, zona,
         precio_max, moneda, habitaciones, banos, metros_min,
         caracteristicas, notas, estado, vence_en)
      VALUES (?, 'cliente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?)
    `).run(
      admin.id, email, primerNombre, email, telefono || null,
      operacion, tipo,
      departamento || null, zona || null,
      presupMax, monedaUso,
      habitaciones ? Number(habitaciones) : null,
      banos ? Number(banos) : null,
      metros ? Number(metros) : null,
      caracteristicas || null,
      notasArr.join('\n') || null,
      vence,
    );

    // 3. Match contra propiedades publicadas en InmobIA (buffer 10% sobre presupuesto)
    let sqlMatch = `SELECT p.id, p.titulo, p.precio, p.usuario_id as asesor_id,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen
      FROM propiedades p WHERE p.publicado_inmobia = 1 AND p.estado = 'activo'`;
    const params = [];
    if (tipo)       { sqlMatch += ' AND LOWER(p.tipo) LIKE ?';      params.push(`%${tipo.toLowerCase()}%`); }
    if (operacion)  { sqlMatch += ' AND LOWER(p.operacion) LIKE ?'; params.push(`%${operacion.toLowerCase()}%`); }
    if (presupMax)  { sqlMatch += ' AND p.precio <= ?';             params.push(presupMax * 1.10); }
    if (departamento && departamento !== 'Guatemala') {
      sqlMatch += ' AND p.departamento = ?'; params.push(departamento);
    } else if (zona) {
      sqlMatch += ' AND (p.zona = ? OR p.municipio = ?)'; params.push(zona, zona);
    }
    sqlMatch += ' LIMIT 10';
    const matches = db.prepare(sqlMatch).all(...params);

    // Helper: detectar si la propiedad está sobre presupuesto del cliente
    const sim = monedaUso === 'USD' ? '$' : 'Q';
    const sobrePresup = (precio) => presupMax && precio > presupMax;
    const pctSobre = (precio) => presupMax ? Math.round(((precio - presupMax) / presupMax) * 100) : 0;

    // 4. Crear lead por cada propiedad que encaja
    const resumen = `Busca: ${tipo} para ${operacion} en ${lugarStr}${presupMax ? ` · hasta ${sim}${Number(presupMax).toLocaleString('es-GT')}` : ''}`;
    const insertLead = db.prepare(`
      INSERT INTO leads (asesor_id, nombre, email, telefono, mensaje, tipo,
        propiedad_id, propiedad_titulo, origen, etapa, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, 'busqueda_personalizada', ?, ?,
        'busqueda_personalizada', 'nuevo', datetime('now'), datetime('now'))
    `);
    const presupTexto = presupMax ? `${sim}${Number(presupMax).toLocaleString('es-GT')}` : null;
    const leadsCreados = [];

    // 4. Crear leads silenciosamente — notificaciones se envían al completar perfil (PATCH /detalles)
    // Propiedades de InmobIA (admin) → modelo '1D', InmobIA gestiona directamente
    // Propiedades de asesores → modelo '2A', asesor recibe el lead
    const tagLead = db.prepare("UPDATE leads SET modelo = ? WHERE id = ?");
    for (const m of matches) {
      const esInmobIA = m.asesor_id === admin.id;
      const r = insertLead.run(m.asesor_id, primerNombre, email, telefono || null, resumen, m.id, m.titulo);
      if (esInmobIA) tagLead.run('1D', r.lastInsertRowid);
      leadsCreados.push(r.lastInsertRowid);
    }

    // Todas las notificaciones (asesores + cliente) se envían en el PATCH /detalles con perfil completo

    res.json({
      ok: true,
      matches: matches.length,
      requerimientoId: reqResult.lastInsertRowid,
      propiedades_preview: matches.slice(0, 3).map(m => ({ titulo: m.titulo, imagen: m.imagen || null })),
    });
  } catch (err) {
    console.error('[busqueda-publica] error:', err.message);
    res.status(500).json({ error: 'Error interno al procesar la búsqueda' });
  }
});

export default router;
