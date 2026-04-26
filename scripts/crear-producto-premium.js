// Script: crear producto Plan Premium InmobIA en Recurrente
// Uso: node --experimental-sqlite backend/scripts/crear-producto-premium.js
//
// Ejecuta UNA SOLA VEZ — copia el ID que imprime y agrégalo al .env:
//   RECURRENTE_PREMIUM_PRODUCT_ID=<id>

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// Import dinámico: debe cargarse DESPUÉS de dotenv.config()
const { crearProductoPremium, keysConfigured } = await import('../lib/recurrente.js');

if (!keysConfigured()) {
  console.error('❌ Faltan RECURRENTE_PUBLIC_KEY o RECURRENTE_SECRET_KEY en .env');
  process.exit(1);
}

try {
  console.log('Creando producto Plan Premium en Recurrente...');
  const producto = await crearProductoPremium();
  console.log('✅ Producto creado:');
  console.log('   ID:', producto.id);
  console.log('   Nombre:', producto.name);
  console.log('   Precio:', producto.prices?.[0]?.amount_in_cents / 100, producto.prices?.[0]?.currency, 'cada', producto.prices?.[0]?.billing_interval);
  console.log('   Link storefront:', producto.storefront_link || '—');
  console.log('');
  console.log('➡️  Agrega al backend/.env:');
  console.log(`   RECURRENTE_PREMIUM_PRODUCT_ID=${producto.id}`);
} catch (err) {
  console.error('❌ Error creando producto:', err.message);
  if (err.data) console.error('   Detalle:', JSON.stringify(err.data, null, 2));
  process.exit(1);
}
