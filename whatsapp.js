/**
 * WhatsApp via Twilio API
 */
import crypto from 'crypto';
import { db } from './database.js';

// Leemos env vars en tiempo de ejecución (no en módulo load) para que dotenv ya esté cargado
function getCreds() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  const listo = !!(sid && token && sid !== 'PENDING' && token !== 'PENDING');
  return { sid, token, from, listo };
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// Log diferido para que dotenv ya esté inicializado
setTimeout(() => {
  const { listo, from } = getCreds();
  if (!listo) console.log('[WA] Twilio no configurado — mensajes desactivados');
  else console.log('[WA] Twilio activo — from:', from);
}, 100);

const phoneLeadMap = new Map();
const cooldown     = new Map();

/**
 * Envía un mensaje de WhatsApp via Twilio.
 * @param {string} telefono - Número guatemalteco (8 dígitos o con 502)
 * @param {string} mensaje
 * @param {number|null} leadId
 */
export async function sendWhatsApp(telefono, mensaje, leadId = null) {
  const { sid, token, from, listo } = getCreds();
  if (!listo) {
    console.log('[WA] Mensaje omitido — Twilio pendiente de configurar');
    return false;
  }
  try {
    let num = String(telefono).replace(/\D/g, '');
    if (num.length === 8) num = `502${num}`;
    const to = `whatsapp:+${num}`;

    const body = new URLSearchParams({ From: from, To: to, Body: mensaje });
    const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const credentials = Buffer.from(`${sid}:${token}`).toString('base64');

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('[WA] Error Twilio:', data?.message || JSON.stringify(data));
      return false;
    }
    console.log(`[WA] ✅ Mensaje enviado a ${to} — SID: ${data.sid}`);
    if (leadId) phoneLeadMap.set(num, leadId);
    return true;
  } catch (e) {
    console.error('[WA] Error enviando mensaje:', e.message);
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
