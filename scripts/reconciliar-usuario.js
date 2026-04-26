// Script: reconcilia el último checkout de un usuario y activa Premium si está pagado
// Uso: node --experimental-sqlite backend/scripts/reconciliar-usuario.js <usuario_id>

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const userId = Number(process.argv[2]);
if (!userId) {
  console.error('Uso: node ... reconciliar-usuario.js <usuario_id>');
  process.exit(1);
}

const { DatabaseSync } = await import('node:sqlite');
const { obtenerCheckout, listarSuscripciones } = await import('../lib/recurrente.js');
const { enviarCorreoBienvenidaPremium } = await import('../email.js');

const db = new DatabaseSync(path.join(__dirname, '../../database/inmobia.db'));

const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(userId);
if (!u) { console.error('Usuario no encontrado'); process.exit(1); }

console.log(`Usuario: ${u.email} (plan actual: ${u.plan})`);
console.log(`Checkout ID: ${u.recurrente_checkout_id || '—'}`);

if (!u.recurrente_checkout_id) {
  console.error('Este usuario no tiene un checkout pendiente');
  process.exit(1);
}

try {
  const checkout = await obtenerCheckout(u.recurrente_checkout_id);
  console.log(`\nEstado del checkout: ${checkout.status}`);
  console.log(`  Monto: ${checkout.total_in_cents / 100} ${checkout.currency}`);
  console.log(`  Modo: ${checkout.live_mode ? 'LIVE' : 'TEST'}`);

  if (checkout.status !== 'paid') {
    console.log('\n⚠️  El checkout aún no está pagado. No se activará Premium.');
    process.exit(0);
  }

  // Buscar suscripción asociada
  let subscriptionId = '';
  try {
    const lista = await listarSuscripciones(1, 50);
    const suscripciones = Array.isArray(lista) ? lista : (lista.data || lista.subscriptions || []);
    const match = suscripciones.find(s =>
      s.subscriber?.email?.toLowerCase() === u.email.toLowerCase() && s.status === 'active'
    );
    if (match) {
      subscriptionId = match.id;
      console.log(`  Suscripción encontrada: ${match.id} (status: ${match.status})`);
    }
  } catch (e) {
    console.warn('  No se pudo listar suscripciones:', e.message);
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
  `).run(u.id, 'reconciliacion_script', 399, 'GTQ', 'pagado', checkout.id, JSON.stringify(checkout));

  console.log(`\n✅ Usuario ${u.email} activado a Premium`);
  console.log(`   Próxima renovación: ${proxima}`);
} catch (err) {
  console.error('\n❌ Error:', err.message);
  if (err.data) console.error('   Detalle:', JSON.stringify(err.data, null, 2));
  process.exit(1);
}
