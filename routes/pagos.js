import { Router } from 'express';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { crearCheckoutPremium, obtenerSuscripcion, cancelarSuscripcion, obtenerCheckout, listarSuscripciones, keysConfigured, verificarFirmaWebhook, webhookSecretConfigured } from '../lib/recurrente.js';
import { enviarCorreoBienvenidaPremium } from '../email.js';

const router = Router();
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

// ── GET /api/pagos/diag (temporal — verificar config)
router.get('/diag', (_req, res) => {
  res.json({
    keysConfigured: keysConfigured(),
    productId: process.env.RECURRENTE_PREMIUM_PRODUCT_ID || null,
    apiUrl: process.env.RECURRENTE_API_URL || null,
    baseUrl: BASE_URL,
    publicKeyLen: (process.env.RECURRENTE_PUBLIC_KEY || '').length,
    secretKeyLen: (process.env.RECURRENTE_SECRET_KEY || '').length,
  });
});

// ── POST /api/pagos/checkout-premium (asesor autenticado)
// Crea una sesión de checkout en Recurrente y devuelve la URL de pago
router.post('/checkout-premium', authMiddleware, async (req, res) => {
  if (!keysConfigured()) {
    return res.status(503).json({ error: 'Pasarela de pagos no configurada' });
  }
  const productId = process.env.RECURRENTE_PREMIUM_PRODUCT_ID;
  if (!productId) {
    return res.status(503).json({ error: 'Producto Premium no configurado en Recurrente' });
  }

  const usuario = db.prepare('SELECT id, nombre, email, plan FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (usuario.plan === 'premium') return res.status(409).json({ error: 'Ya tienes plan Premium activo' });

  try {
    const checkout = await crearCheckoutPremium({
      productId,
      usuario,
      successUrl: `${BASE_URL}/panel-asesor.html?pago=exito`,
      cancelUrl:  `${BASE_URL}/panel-asesor.html?pago=cancelado`,
    });

    // Guardar referencia del checkout para poder reconciliar después
    db.prepare('UPDATE usuarios SET recurrente_checkout_id = ?, premium_estado = ? WHERE id = ?')
      .run(checkout.id || '', 'pendiente', usuario.id);

    db.prepare(`
      INSERT INTO pagos (usuario_id, tipo, monto, moneda, estado, recurrente_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(usuario.id, 'checkout_premium', 399, 'GTQ', 'pendiente', checkout.id || '', JSON.stringify(checkout));

    res.json({
      checkout_id: checkout.id,
      url: checkout.checkout_url || checkout.url,
    });
  } catch (err) {
    console.error('Error creando checkout Premium:', err.message, err.data || '');
    res.status(err.status || 500).json({ error: 'No se pudo generar el checkout', detalle: err.message });
  }
});

// ── POST /api/pagos/reconciliar (asesor autenticado)
// Consulta el último checkout del usuario en Recurrente y si está pagado,
// activa el plan Premium. Útil cuando el webhook no llegó (dev/localhost).
router.post('/reconciliar', authMiddleware, async (req, res) => {
  const u = db.prepare(`
    SELECT id, email, plan, recurrente_checkout_id, recurrente_subscription_id
    FROM usuarios WHERE id = ?
  `).get(req.usuario.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (!u.recurrente_checkout_id) {
    return res.status(404).json({ error: 'No hay pago pendiente de reconciliar' });
  }

  try {
    const checkout = await obtenerCheckout(u.recurrente_checkout_id);
    console.log('🔎 Checkout Recurrente:', checkout.id, '→', checkout.status);

    if (checkout.status !== 'paid') {
      return res.json({
        ok: false,
        estado: checkout.status,
        mensaje: 'El pago aún no se ha completado en Recurrente',
      });
    }

    // Pago confirmado — intentar obtener la subscription asociada
    let subscriptionId = '';
    try {
      const lista = await listarSuscripciones(1, 50);
      const suscripciones = Array.isArray(lista) ? lista : (lista.data || lista.subscriptions || []);
      const match = suscripciones.find(s =>
        s.subscriber?.email?.toLowerCase() === u.email.toLowerCase() && s.status === 'active'
      );
      if (match) subscriptionId = match.id;
    } catch (e) {
      console.warn('No se pudo listar suscripciones:', e.message);
    }

    const ahora = new Date().toISOString();
    const proxima = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE usuarios
      SET plan = 'premium',
          premium_estado = 'activa',
          premium_activado_en = COALESCE(NULLIF(premium_activado_en, ''), ?),
          premium_renovacion_en = ?,
          recurrente_subscription_id = COALESCE(NULLIF(?, ''), recurrente_subscription_id)
      WHERE id = ?
    `).run(ahora, proxima, subscriptionId, u.id);

    db.prepare(`
      INSERT INTO pagos (usuario_id, tipo, monto, moneda, estado, recurrente_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(u.id, 'reconciliacion_manual', 399, 'GTQ', 'pagado', checkout.id, JSON.stringify(checkout));

    // Correo de bienvenida Premium (no bloqueante si falla)
    const datosUsuario = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(u.id);
    enviarCorreoBienvenidaPremium({
      email: datosUsuario?.email,
      nombre: datosUsuario?.nombre,
      monto: (checkout.total_in_cents ? (checkout.total_in_cents / 100).toFixed(2) : '399.00'),
      moneda: checkout.currency || 'GTQ',
      renovacionISO: proxima,
      checkoutId: checkout.id,
    }).then(r => {
      if (r.ok) console.log('📧 Correo Premium enviado a', datosUsuario?.email);
    });

    res.json({
      ok: true,
      plan: 'premium',
      mensaje: '¡Premium activado!',
      renovacion: proxima,
    });
  } catch (err) {
    console.error('Error reconciliando:', err.message, err.data || '');
    res.status(err.status || 500).json({ error: 'No se pudo verificar el pago', detalle: err.message });
  }
});

// ── GET /api/pagos/mi-suscripcion (asesor autenticado)
router.get('/mi-suscripcion', authMiddleware, (req, res) => {
  const u = db.prepare(`
    SELECT plan, premium_estado, premium_activado_en, premium_renovacion_en,
           recurrente_subscription_id, recurrente_checkout_id
    FROM usuarios WHERE id = ?
  `).get(req.usuario.id);
  res.json(u || {});
});

// ── POST /api/pagos/cancelar-premium (asesor autenticado)
router.post('/cancelar-premium', authMiddleware, async (req, res) => {
  const u = db.prepare('SELECT recurrente_subscription_id FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (!u?.recurrente_subscription_id) {
    return res.status(404).json({ error: 'No tienes una suscripción activa' });
  }
  try {
    await cancelarSuscripcion(u.recurrente_subscription_id);
    db.prepare('UPDATE usuarios SET premium_estado = ? WHERE id = ?').run('cancelada', req.usuario.id);
    res.json({ ok: true, mensaje: 'Suscripción cancelada — seguirá activa hasta el final del periodo pagado' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /api/pagos/webhook (público — lo llama Recurrente)
// Recibe eventos de pago/suscripción y actualiza el plan del asesor.
// Blindaje: verificación de firma (si hay secret) + idempotencia por evento_id.
router.post('/webhook', async (req, res) => {
  // 1) Verificar firma (si hay secret configurado)
  const firma = verificarFirmaWebhook(req.rawBody, req.headers);
  if (!firma.ok) {
    console.warn('🛑 Webhook rechazado:', firma.motivo);
    return res.status(401).json({ error: 'firma inválida' });
  }

  const evento = req.body || {};
  const tipo = evento.event_type || evento.type || '';
  const data = evento.data || evento;

  // Identificador único del evento (para idempotencia). Recurrente expone distintos
  // campos según el tipo: event.id, evento.id, data.id + type como fallback.
  const eventoId = evento.id || evento.event_id || data.event_id
                 || (data.id && tipo ? `${tipo}:${data.id}` : '')
                 || `${tipo}:${Date.now()}`;

  console.log('📨 Webhook Recurrente:', tipo, '→ evento_id:', eventoId, '· firma:', firma.modo);

  // 2) Idempotencia — si ya procesamos este evento, respondemos 200 sin re-ejecutar
  const yaProcesado = db.prepare('SELECT id, resultado FROM webhook_eventos WHERE evento_id = ?').get(eventoId);
  if (yaProcesado) {
    console.log('↩️  Evento duplicado, ignorado:', eventoId);
    return res.json({ received: true, duplicado: true, resultado: yaProcesado.resultado });
  }

  try {
    // 3) Resolver usuario
    let usuarioId = null;
    if (data.metadata?.usuario_id) {
      usuarioId = Number(data.metadata.usuario_id);
    } else if (data.checkout?.metadata?.usuario_id) {
      usuarioId = Number(data.checkout.metadata.usuario_id);
    } else if (data.subscriber?.email) {
      const u = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(data.subscriber.email);
      if (u) usuarioId = u.id;
    }

    // 4) Registrar el evento en bitácora de pagos (siempre, aunque no haya usuario)
    db.prepare(`
      INSERT INTO pagos (usuario_id, tipo, estado, recurrente_id, recurrente_evento, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      usuarioId || 0,
      'webhook',
      tipo,
      data.id || '',
      tipo,
      JSON.stringify(evento)
    );

    let resultado = 'sin_accion';

    if (!usuarioId) {
      console.warn('⚠️  Webhook sin usuario_id identificable:', tipo);
      resultado = 'sin_usuario';
    } else {
      // Detectar tipo de pago — comisión puntual vs Premium mensual
      const metaTipo = data.metadata?.tipo || data.checkout?.metadata?.tipo || '';
      const leadIdPago = Number(data.metadata?.lead_id || data.checkout?.metadata?.lead_id || 0) || null;

      // 5) Actualizar estado según el evento
      switch (tipo) {
        case 'checkout.completed':
        case 'invoice.paid':
        case 'payment.succeeded': {
          // Si es cobro de comisión puntual, actualizar el lead y salir del switch
          if (metaTipo === 'comision_cierre' && leadIdPago) {
            const ahoraC = new Date().toISOString();
            db.prepare(`UPDATE leads SET comision_estado = 'pagada', comision_pagada_en = ? WHERE id = ?`)
              .run(ahoraC, leadIdPago);
            console.log(`💰 Comisión pagada — lead ${leadIdPago}`);
            resultado = 'comision_pagada';
            break;
          }
          // Si no es comisión, cae a la rama de Premium (subscription.*)
          // — dejamos que caiga al siguiente case con fallthrough explícito
        }
        // eslint-disable-next-line no-fallthrough
        case 'subscription.created':
        case 'subscription.activated': {
          const ahora = new Date().toISOString();
          const proxima = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const prev = db.prepare('SELECT plan, premium_estado FROM usuarios WHERE id = ?').get(usuarioId);
          db.prepare(`
            UPDATE usuarios
            SET plan = 'premium',
                premium_estado = 'activa',
                premium_activado_en = COALESCE(NULLIF(premium_activado_en, ''), ?),
                premium_renovacion_en = ?,
                recurrente_subscription_id = COALESCE(NULLIF(?, ''), recurrente_subscription_id)
            WHERE id = ?
          `).run(ahora, proxima, data.subscription?.id || data.id || '', usuarioId);
          console.log(`✅ Usuario ${usuarioId} activado/renovado a Premium`);
          resultado = 'premium_activado';

          // Correo de bienvenida solo en la primera activación (no en renovaciones)
          const esActivacionNueva = !prev || prev.plan !== 'premium' || prev.premium_estado !== 'activa';
          if (esActivacionNueva) {
            const dU = db.prepare('SELECT nombre, email, referidor_id FROM usuarios WHERE id = ?').get(usuarioId);
            const monto = data.amount_in_cents ? (data.amount_in_cents / 100).toFixed(2)
                        : data.total_in_cents ? (data.total_in_cents / 100).toFixed(2)
                        : '399.00';
            enviarCorreoBienvenidaPremium({
              email: dU?.email,
              nombre: dU?.nombre,
              monto,
              moneda: data.currency || 'GTQ',
              renovacionISO: proxima,
              checkoutId: data.id || data.subscription?.id || '',
            }).then(r => {
              if (r.ok) console.log('📧 Correo Premium (webhook) enviado a', dU?.email);
            });

            // ── RECOMPENSA AL REFERIDOR ─────────────────────────────
            if (dU?.referidor_id) {
              const referidor = db.prepare('SELECT id, nombre, email, plan, premium_renovacion_en FROM usuarios WHERE id = ?').get(dU.referidor_id);
              if (referidor) {
                const ahora30 = new Date();

                if (referidor.plan === 'premium' && referidor.premium_renovacion_en) {
                  // Ya es Premium pagando → extender renovación 30 días
                  const renovacionActual = new Date(referidor.premium_renovacion_en);
                  renovacionActual.setDate(renovacionActual.getDate() + 30);
                  db.prepare(`UPDATE usuarios SET premium_renovacion_en = ? WHERE id = ?`)
                    .run(renovacionActual.toISOString(), referidor.id);
                  console.log(`🎁 Referidor ${referidor.id} (Premium): renovación extendida 30 días → ${renovacionActual.toISOString()}`);
                } else {
                  // Está en plan gratis → activar 1 mes Premium gratuito
                  ahora30.setDate(ahora30.getDate() + 30);
                  db.prepare(`
                    UPDATE usuarios
                    SET plan = 'premium',
                        premium_estado = 'activa',
                        premium_activado_en = COALESCE(NULLIF(premium_activado_en, ''), datetime('now')),
                        premium_renovacion_en = ?
                    WHERE id = ?
                  `).run(ahora30.toISOString(), referidor.id);
                  console.log(`🎁 Referidor ${referidor.id} (Gratis): 1 mes Premium gratuito activado`);
                }

                // Notificación interna al referidor
                db.prepare(`
                  INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, creado_en)
                  VALUES (?, 'referido_premium', '¡Tu referido activó Premium!', ?, datetime('now'))
                `).run(
                  referidor.id,
                  referidor.plan === 'premium'
                    ? `${dU.nombre} activó Premium. Tu suscripción se extendió 30 días gratis.`
                    : `${dU.nombre} activó Premium. ¡Tienes 1 mes de Premium gratis!`
                );
              }
            }
          }
          break;
        }
        case 'subscription.cancelled':
        case 'subscription.canceled': {
          db.prepare(`UPDATE usuarios SET premium_estado = 'cancelada' WHERE id = ?`).run(usuarioId);
          resultado = 'cancelada';
          break;
        }
        case 'subscription.past_due':
        case 'payment.failed': {
          db.prepare(`UPDATE usuarios SET premium_estado = 'atrasada' WHERE id = ?`).run(usuarioId);
          resultado = 'atrasada';
          break;
        }
        case 'subscription.ended':
        case 'subscription.expired': {
          db.prepare(`UPDATE usuarios SET plan = 'gratis', premium_estado = 'expirada' WHERE id = ?`).run(usuarioId);
          resultado = 'expirada_downgrade';
          break;
        }
        default:
          resultado = 'evento_no_manejado';
      }
    }

    // 6) Marcar evento como procesado para idempotencia futura
    try {
      db.prepare(`
        INSERT INTO webhook_eventos (evento_id, tipo, usuario_id, resultado)
        VALUES (?, ?, ?, ?)
      `).run(eventoId, tipo, usuarioId || null, resultado);
    } catch (err) {
      // Si hay colisión (UNIQUE), ignoramos — ya está registrado
      if (!String(err.message).includes('UNIQUE')) throw err;
    }

    res.json({ received: true, resultado });
  } catch (err) {
    console.error('❌ Error procesando webhook:', err.message);
    // Siempre devolver 200 para que Recurrente no reintente en loop ante errores nuestros
    res.json({ received: true, error: err.message });
  }
});

// ── GET /api/pagos/webhook/diag (admin) — últimos eventos recibidos para depurar
router.get('/webhook/diag', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const eventos = db.prepare(`
    SELECT evento_id, tipo, usuario_id, resultado, procesado_en
    FROM webhook_eventos ORDER BY id DESC LIMIT 50
  `).all();
  res.json({
    webhook_secret_configured: webhookSecretConfigured(),
    total: eventos.length,
    eventos,
  });
});

export default router;
