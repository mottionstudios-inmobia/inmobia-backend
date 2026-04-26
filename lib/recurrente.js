// Cliente para la API de Recurrente (recurrente.com)
// Docs: https://docs.recurrente.com

import crypto from 'crypto';

const API_URL = process.env.RECURRENTE_API_URL || 'https://app.recurrente.com/api';
const PUBLIC_KEY = process.env.RECURRENTE_PUBLIC_KEY || '';
const SECRET_KEY = process.env.RECURRENTE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.RECURRENTE_WEBHOOK_SECRET || '';

// Headers estándar — la API de Recurrente usa X-PUBLIC-KEY + X-SECRET-KEY
function headers(soloPublic = false) {
  const h = {
    'X-PUBLIC-KEY': PUBLIC_KEY,
    'Content-Type': 'application/json',
  };
  if (!soloPublic) h['X-SECRET-KEY'] = SECRET_KEY;
  return h;
}

async function request(method, path, body = null, soloPublic = false) {
  const opts = { method, headers: headers(soloPublic) };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_URL}${path}`, opts);
  const texto = await res.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }

  if (!res.ok) {
    const err = new Error(data.error || data.message || `Recurrente ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Productos ──
// Crea un producto con precio recurrente (para el plan Premium Q399/mes)
export async function crearProductoPremium() {
  return request('POST', '/products', {
    product: {
      name: 'Plan Premium InmobIA',
      description: 'Acceso a leads ilimitados, red colaborativa y automatizaciones',
      prices_attributes: [{
        amount_in_cents: 39900,
        currency: 'GTQ',
        charge_type: 'recurring',
        billing_interval: 'month',
        billing_interval_count: 1,
      }],
    },
  });
}

// Crea un producto one-time por el monto exacto de una comisión puntual
// (cierre). Lo usamos porque Recurrente pide product_id en el checkout.
export async function crearProductoComision({ leadId, montoCentavos, moneda = 'GTQ', concepto }) {
  return request('POST', '/products', {
    product: {
      name: concepto || `Comisión InmobIA · Cierre #${leadId}`,
      description: 'Pago único de comisión InmobIA por cierre confirmado',
      prices_attributes: [{
        amount_in_cents: montoCentavos,
        currency: moneda,
        charge_type: 'one_time',
      }],
    },
  });
}

// Genera un checkout (link de pago) para cobrar una comisión puntual a un asesor.
// Devuelve { id, checkout_url | url }
export async function crearCheckoutComision({ leadId, usuario, montoQ, moneda = 'GTQ', successUrl, cancelUrl }) {
  const montoCentavos = Math.round(Number(montoQ) * 100);
  if (!montoCentavos || montoCentavos < 100) {
    const err = new Error('Monto de comisión inválido');
    err.status = 400;
    throw err;
  }

  const producto = await crearProductoComision({
    leadId,
    montoCentavos,
    moneda,
    concepto: `Comisión InmobIA · Cierre #${leadId}`,
  });

  const productId = producto.id || producto.product?.id;
  if (!productId) {
    const err = new Error('No se obtuvo product_id al crear producto comisión');
    err.status = 502;
    err.data = producto;
    throw err;
  }

  const body = {
    items: [{ product_id: productId }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      usuario_id: String(usuario.id),
      email: usuario.email,
      tipo: 'comision_cierre',
      lead_id: String(leadId),
    },
  };
  return request('POST', '/checkouts', body, true);
}

// ── Checkouts ──
// Crea una sesión de checkout para activar una suscripción Premium
export async function crearCheckoutPremium({ productId, usuario, successUrl, cancelUrl }) {
  const body = {
    items: [{ product_id: productId }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      usuario_id: String(usuario.id),
      email: usuario.email,
      tipo: 'premium_mensual',
    },
  };
  // El checkout solo requiere public key
  return request('POST', '/checkouts', body, true);
}

// Obtener detalles de un checkout por ID (requiere secret key)
export async function obtenerCheckout(checkoutId) {
  return request('GET', `/checkouts/${checkoutId}`);
}

// ── Suscripciones ──
export async function obtenerSuscripcion(subscriptionId) {
  return request('GET', `/subscriptions/${subscriptionId}`);
}

// Lista de suscripciones (para buscar la del cliente por email)
export async function listarSuscripciones(page = 1, items = 20) {
  return request('GET', `/subscriptions?page=${page}&items=${items}`);
}

export async function cancelarSuscripcion(subscriptionId) {
  return request('POST', `/subscriptions/${subscriptionId}/cancel`);
}

// ── Webhooks ──
export async function registrarWebhook(url, description = 'InmobIA events') {
  return request('POST', '/webhook_endpoints', { url, description });
}

export function keysConfigured() {
  return !!(PUBLIC_KEY && SECRET_KEY);
}

// ── Webhook signature verification ──
// Recurrente puede enviar la firma en distintos headers según el plan/versión.
// Esta función es tolerante: si hay secret configurado, valida HMAC-SHA256 contra
// cualquier firma encontrada. Si no hay secret, deja pasar (modo dev).
export function verificarFirmaWebhook(rawBody, headers) {
  if (!WEBHOOK_SECRET) {
    return { ok: true, modo: 'sin_secret' };
  }
  if (!rawBody) return { ok: false, motivo: 'sin raw body' };

  const firmaRecibida = headers['x-recurrente-signature']
                     || headers['x-webhook-signature']
                     || headers['x-signature']
                     || '';
  if (!firmaRecibida) return { ok: false, motivo: 'sin header de firma' };

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  // Comparar tolerando prefijo tipo "sha256=..."
  const limpia = firmaRecibida.replace(/^sha256=/, '').trim();
  const ok = limpia.length === hmac.length && crypto.timingSafeEqual(
    Buffer.from(limpia, 'hex'),
    Buffer.from(hmac, 'hex')
  );
  return ok ? { ok: true, modo: 'hmac' } : { ok: false, motivo: 'firma inválida' };
}

export function webhookSecretConfigured() {
  return !!WEBHOOK_SECRET;
}
