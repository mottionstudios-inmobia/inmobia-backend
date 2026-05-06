/**
 * WhatsApp — Green API (principal) con fallback a Twilio
 */
import crypto from 'crypto';
import { db } from './database.js';
import { enviarEmail } from './email.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

function getGreenCreds() {
  const instance = process.env.GREEN_API_INSTANCE;
  const token    = process.env.GREEN_API_TOKEN;
  const apiBase  = process.env.GREEN_API_URL || 'https://7107.api.greenapi.com';
  const listo    = !!(instance && token);
  return { instance, token, apiBase, listo };
}

function getTwilioCreds() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  const listo = !!(sid && token && sid !== 'PENDING' && token !== 'PENDING');
  return { sid, token, from, listo };
}

setTimeout(() => {
  const g = getGreenCreds();
  const t = getTwilioCreds();
  if (g.listo)      console.log('[WA] Green API activo — instancia:', g.instance);
  else if (t.listo) console.log('[WA] Twilio activo (fallback) — from:', t.from);
  else              console.log('[WA] Sin proveedor WA configurado — mensajes desactivados');
}, 100);

const phoneLeadMap   = new Map();
const cooldown       = new Map();
const asesorCooldown = new Map(); // evitar spam de WA al asesor

/**
 * Envía un mensaje de WhatsApp.
 * Usa Green API si está configurado, si no Twilio.
 * @param {string} telefono - Número guatemalteco (8 dígitos o con 502)
 * @param {string} mensaje
 * @param {number|null} leadId
 */
export async function sendWhatsApp(telefono, mensaje, leadId = null) {
  let num = String(telefono).replace(/\D/g, '');
  if (num.length === 8) num = `502${num}`;

  const green = getGreenCreds();
  if (green.listo) {
    return await sendViaGreenAPI(num, mensaje, leadId, green);
  }

  const twilio = getTwilioCreds();
  if (twilio.listo) {
    return await sendViaTwilio(num, mensaje, leadId, twilio);
  }

  console.log('[WA] Mensaje omitido — sin proveedor configurado');
  return false;
}

async function sendViaGreenAPI(num, mensaje, leadId, { instance, token, apiBase }) {
  try {
    const chatId = `${num}@c.us`;
    const url    = `${apiBase}/waInstance${instance}/sendMessage/${token}`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chatId, message: mensaje }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      console.error('[WA Green] Error:', data?.error || JSON.stringify(data));
      return false;
    }
    console.log(`[WA Green] ✅ Enviado a ${chatId} — id: ${data.idMessage}`);
    if (leadId) phoneLeadMap.set(num, leadId);
    return true;
  } catch (e) {
    console.error('[WA Green] Error:', e.message);
    return false;
  }
}

async function sendViaTwilio(num, mensaje, leadId, { sid, token, from }) {
  try {
    const to   = `whatsapp:+${num}`;
    const body = new URLSearchParams({ From: from, To: to, Body: mensaje });
    const res  = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method:  'POST',
      headers: { 'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    const data = await res.json();
    if (!res.ok) { console.error('[WA Twilio] Error:', data?.message); return false; }
    console.log(`[WA Twilio] ✅ Enviado a ${to} — SID: ${data.sid}`);
    if (leadId) phoneLeadMap.set(num, leadId);
    return true;
  } catch (e) {
    console.error('[WA Twilio] Error:', e.message);
    return false;
  }
}

export function whatsappReady() {
  return getGreenCreds().listo || getTwilioCreds().listo;
}

/**
 * Notifica al asesor (WA + panel) cuando un cliente le escribe a InmobIA.
 * La comunicación se centraliza en el chat del lead — NO se reenvía el texto del cliente.
 * Solo se envía una alerta indicando que hay un nuevo mensaje en el panel.
 * No aplica para leads de admin (admin ve el WA directo en su teléfono).
 */
async function notificarAsesor(lead, texto) {
  const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];

  // Notificación en el panel (siempre, para cada mensaje)
  try {
    db.prepare(`INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, referencia_id)
      VALUES (?, 'wa-entrante', ?, ?, ?)`)
      .run(
        lead.asesor_id,
        `💬 ${primerNombre} te envió un mensaje`,
        'El cliente escribió a InmobIA. Revisa la ficha del lead para ver el mensaje.',
        lead.id
      );
  } catch (e) {
    console.error('[WA notif panel]', e.message);
  }

  // WA al asesor — cooldown 3 min por lead para no spam
  // Solo alerta de notificación, sin incluir el texto del cliente
  const coolKey = `asesor-${lead.id}`;
  const ahora   = Date.now();
  if (asesorCooldown.has(coolKey) && ahora - asesorCooldown.get(coolKey) < 3 * 60 * 1000) return;
  asesorCooldown.set(coolKey, ahora);

  if (!lead.asesor_telefono) return;

  const linkLead = `${BASE_URL}/panel-asesor.html?lead=${lead.id}`;
  const msg =
`🏠 *InmobIA — Nuevo mensaje*

*${primerNombre}* te escribió un mensaje desde el portal.

Para ver y responder, ingresa a la ficha del lead:
📋 ${linkLead}`;

  await sendWhatsApp(lead.asesor_telefono, msg);
  console.log(`[WA] 📤 Alerta enviada al asesor #${lead.asesor_id} — lead #${lead.id}`);

  // Email al asesor
  if (lead.asesor_email) {
    const linkLead2 = `${BASE_URL}/panel-asesor.html?lead=${lead.id}`;
    enviarEmail({
      to:      lead.asesor_email,
      subject: `💬 ${primerNombre} te envió un mensaje — InmobIA`,
      html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#1e2d4a;padding:20px 24px;border-radius:8px 8px 0 0">
    <img src="${BASE_URL}/logo-inmobia-avatar.png" alt="InmobIA" style="height:36px">
  </div>
  <div style="background:#f9f9f9;padding:28px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e5e5">
    <h2 style="color:#1e2d4a;margin:0 0 12px">Nuevo mensaje de cliente</h2>
    <p style="color:#333;margin:0 0 20px">
      <strong>${primerNombre}</strong> te envió un mensaje a través del portal InmobIA.
      Para ver el mensaje y responder, ingresa a la ficha del lead.
    </p>
    <a href="${linkLead2}" style="display:inline-block;background:#e07b39;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600">
      📋 Ver ficha del lead
    </a>
    <p style="color:#999;font-size:0.8rem;margin:24px 0 0">
      Toda la comunicación con el cliente se centraliza en InmobIA para garantizar trazabilidad.
    </p>
  </div>
</div>`,
    }).catch(e => console.error('[Email notif asesor]', e.message));
  }
}

function procesarMensajeEntrante(numRaw, texto, logTag) {
  registrarEntrante(numRaw, texto);

  const lead = buscarLead(numRaw);
  if (!lead) {
    console.log(`[WA ${logTag}] Mensaje de ${numRaw} — sin lead activo`);
    return;
  }

  // Notificar al asesor si no es admin (admin ve el WA directamente en su teléfono)
  if (lead.asesor_rol !== 'admin') {
    notificarAsesor(lead, texto).catch(e => console.error('[WA notif asesor]', e.message));
  }

  // Auto-respuesta al cliente con cooldown de 5 min
  const ahora = Date.now();
  if (cooldown.has(numRaw) && ahora - cooldown.get(numRaw) < 5 * 60 * 1000) return;
  cooldown.set(numRaw, ahora);

  const token  = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)')
    .run(token, (lead.email || '').toLowerCase().trim(), lead.id, expira);
  const linkPanel = `${BASE_URL}/panel-cliente.html?token=${token}`;

  const primerNombre = (lead.nombre || 'Cliente').split(' ')[0];
  const autoReply =
`Hola *${primerNombre}*, gracias por escribirnos. 🏠

Recibimos tu mensaje. Para coordinar los detalles de tu visita, ingresa a tu panel personal:

${linkPanel}

Si tienes alguna duda urgente, responde a este mensaje.`;

  sendWhatsApp(numRaw, autoReply).catch(e => console.error(`[WA ${logTag} auto-reply]`, e.message));
}

/**
 * Procesa mensajes entrantes del webhook de Green API.
 * Green API envía POST JSON con typeWebhook + senderData + messageData
 */
export function procesarWebhookGreenAPI(body) {
  try {
    if (body?.typeWebhook !== 'incomingMessageReceived') return;
    const chatId = body?.senderData?.chatId || '';
    const texto  = body?.messageData?.textMessageData?.textMessage || '';
    // chatId formato: 502XXXXXXXX@c.us
    const numRaw = chatId.replace('@c.us', '').replace(/\D/g, '');
    if (!texto.trim() || !numRaw) return;
    procesarMensajeEntrante(numRaw, texto, 'Green');
  } catch (e) {
    console.error('[WA Green webhook]', e.message);
  }
}

/**
 * Procesa mensajes entrantes del webhook de Twilio.
 */
export function procesarWebhookTwilio(body) {
  try {
    const texto  = body?.Body || '';
    const numRaw = String(body?.From || '').replace(/\D/g, '');
    if (!texto.trim() || !numRaw) return;
    procesarMensajeEntrante(numRaw, texto, 'Twilio');
  } catch (e) {
    console.error('[WA Twilio webhook]', e.message);
  }
}

// Compatibilidad con imports anteriores
export const procesarWebhookMeta = procesarWebhookTwilio;

function buscarLead(numRaw) {
  const porMapa = phoneLeadMap.get(numRaw);
  if (porMapa) {
    return db.prepare(`SELECT l.*, u.nombre AS asesor_nombre, u.email AS asesor_email, u.telefono AS asesor_telefono, u.rol AS asesor_rol
      FROM leads l
      LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.id = ? AND l.etapa NOT IN ('cerrado','inactivo','perdido')`).get(porMapa);
  }
  const sinCodigo = numRaw.startsWith('502') && numRaw.length === 11 ? numRaw.slice(3) : numRaw;
  return db.prepare(`SELECT l.*, u.nombre AS asesor_nombre, u.email AS asesor_email, u.telefono AS asesor_telefono, u.rol AS asesor_rol
    FROM leads l
    LEFT JOIN usuarios u ON u.id = l.asesor_id
    WHERE (REPLACE(REPLACE(REPLACE(l.telefono,' ',''),'-',''),'+','') = ?
        OR REPLACE(REPLACE(REPLACE(l.telefono,' ',''),'-',''),'+','') = ?)
    AND l.etapa NOT IN ('cerrado','inactivo','perdido')
    ORDER BY l.creado_en DESC LIMIT 1`).get(numRaw, sinCodigo);
}

function registrarEntrante(numRaw, texto) {
  const lead = buscarLead(numRaw);
  if (!lead) return;
  db.prepare(`INSERT INTO lead_bitacora (lead_id, asesor_id, tipo, nota) VALUES (?, ?, 'wa-entrante', ?)`)
    .run(lead.id, lead.asesor_id, texto.slice(0, 1000));
  console.log(`[WA] 📩 Entrante de ${numRaw} (lead #${lead.id}): "${texto.slice(0, 60)}"`);
}
