/**
 * WhatsApp — Green API (principal) con fallback a Twilio
 */
import crypto from 'crypto';
import { db } from './database.js';

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

const phoneLeadMap = new Map();
const cooldown     = new Map();

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
  return getCreds().listo;
}

/**
 * Procesa mensajes entrantes del webhook de Twilio.
 */
export function procesarWebhookTwilio(body) {
  try {
    const texto  = body?.Body || '';
    const numRaw = String(body?.From || '').replace(/\D/g, '');
    if (!texto.trim() || !numRaw) return;

    const ahora = Date.now();
    if (cooldown.has(numRaw) && ahora - cooldown.get(numRaw) < 5 * 60 * 1000) {
      registrarEntrante(numRaw, texto);
      return;
    }

    registrarEntrante(numRaw, texto);
    cooldown.set(numRaw, ahora);

    const lead = buscarLead(numRaw);
    if (!lead) {
      console.log(`[WA] Mensaje de ${numRaw} — sin lead activo`);
      return;
    }

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

    sendWhatsApp(numRaw, autoReply).catch(e => console.error('[WA auto-reply]', e.message));
  } catch (e) {
    console.error('[WA webhook]', e.message);
  }
}

// Compatibilidad con imports anteriores
export const procesarWebhookMeta = procesarWebhookTwilio;

function buscarLead(numRaw) {
  const porMapa = phoneLeadMap.get(numRaw);
  if (porMapa) {
    return db.prepare(`SELECT l.*, u.nombre AS asesor_nombre FROM leads l
      LEFT JOIN usuarios u ON u.id = l.asesor_id
      WHERE l.id = ? AND l.etapa NOT IN ('cerrado','inactivo','perdido')`).get(porMapa);
  }
  const sinCodigo = numRaw.startsWith('502') && numRaw.length === 11 ? numRaw.slice(3) : numRaw;
  return db.prepare(`SELECT l.*, u.nombre AS asesor_nombre FROM leads l
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
