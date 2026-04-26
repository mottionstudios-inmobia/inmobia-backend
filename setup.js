/**
 * Script de configuración inicial — crea el primer usuario admin
 * Uso: node setup.js
 */
import bcrypt from 'bcryptjs';
import { db } from './database.js';

const EMAIL    = 'admin@inmobia.site';
const PASSWORD = 'InmobIA2024!';  // Cambia esto antes de producción
const NOMBRE   = 'Administrador';

const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(EMAIL);

if (existe) {
  console.log(`✓ El usuario ${EMAIL} ya existe (id: ${existe.id})`);
  process.exit(0);
}

const hash = bcrypt.hashSync(PASSWORD, 10);
const res  = db.prepare(
  'INSERT INTO usuarios (nombre, email, password, rol) VALUES (?, ?, ?, ?)'
).run(NOMBRE, EMAIL, hash, 'admin');

console.log(`\n✅ Usuario admin creado exitosamente`);
console.log(`   Email:      ${EMAIL}`);
console.log(`   Contraseña: ${PASSWORD}`);
console.log(`   ID:         ${res.lastInsertRowid}`);
console.log(`\n⚠️  Cambia la contraseña después del primer inicio de sesión.\n`);
