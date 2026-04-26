// Test end-to-end del Sprint 1 — flujo completo de cierre + verificación cliente + cobro comisión
// Usa HTTP real contra localhost:3001 para ejercer todo el stack

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const API = 'http://localhost:3001/api';
const SECRET = process.env.JWT_SECRET || 'inmobia_secret_2024';

const LEAD_ID = Number(process.argv[2]) || 21;
const VALOR_CIERRE = Number(process.argv[3]) || 15000;
const MONEDA = process.argv[4] || 'GTQ';

function paso(n, titulo) {
  console.log(`\n━━━ PASO ${n} ━━━ ${titulo}`);
}

async function main() {
  console.log(`🧪 Test flujo cierre — lead ${LEAD_ID}, valor ${MONEDA} ${VALOR_CIERRE}`);

  // 1) Cargar lead + asesor desde la DB (necesitamos JWT real)
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../database/inmobia.db'));

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(LEAD_ID);
  if (!lead) throw new Error(`Lead ${LEAD_ID} no existe`);
  if (!lead.email) throw new Error(`Lead ${LEAD_ID} no tiene email — no se puede probar verificación cliente`);

  const asesor = db.prepare('SELECT id, email, rol, nombre, telefono FROM usuarios WHERE id = ?').get(lead.asesor_id);
  if (!asesor) throw new Error(`Asesor ${lead.asesor_id} no existe`);

  console.log(`  Lead:   #${lead.id} — ${lead.nombre} <${lead.email}>`);
  console.log(`  Asesor: #${asesor.id} — ${asesor.nombre} <${asesor.email}> · tel ${asesor.telefono || '—'}`);

  // Limpiar estado previo del lead (para poder re-correr el test)
  db.prepare(`UPDATE leads SET etapa = 'visita-realizada',
    cierre_declarado_en = NULL, cierre_verificacion_estado = NULL, cierre_verificado_en = NULL,
    comision_checkout_id = NULL, comision_link_pago = NULL, comision_link_creado_en = NULL,
    comision_pagada_en = NULL, comision_estado = NULL WHERE id = ?`).run(LEAD_ID);
  console.log(`  ↪ Estado del lead limpiado para test limpio`);

  const tokenAsesor = jwt.sign(
    { id: asesor.id, email: asesor.email, rol: asesor.rol },
    SECRET, { expiresIn: '1h' }
  );

  // ── PASO 1: asesor declara cierre
  paso(1, 'Asesor declara cierre');
  let r = await fetch(`${API}/leads/${LEAD_ID}/cerrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAsesor}` },
    body: JSON.stringify({ valor_cierre: VALOR_CIERRE, moneda: MONEDA }),
  });
  let data = await r.json();
  console.log(`  HTTP ${r.status}`, JSON.stringify(data, null, 2));
  if (!r.ok) throw new Error('Falló declarar cierre');

  // ── PASO 2: obtener el magic_link generado para el cliente
  paso(2, 'Magic link del cliente (lo recibiría por email)');
  const ml = db.prepare('SELECT * FROM magic_links WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(LEAD_ID);
  if (!ml) throw new Error('No se creó magic_link');
  console.log(`  token: ${ml.token.slice(0, 20)}…`);
  console.log(`  email: ${ml.email}`);
  console.log(`  link completo: ${process.env.BASE_URL || 'http://localhost:5173'}/panel-cliente.html?token=${ml.token}&accion=confirmar-cierre&lead=${LEAD_ID}`);

  // Estado del lead después de declarar
  let leadDb = db.prepare('SELECT etapa, cierre_declarado_en, cierre_verificacion_estado, valor_cierre, comision_inmobia, comision_asesor, modelo FROM leads WHERE id = ?').get(LEAD_ID);
  console.log(`  lead.estado:`, leadDb);

  // ── PASO 3: cliente confirma el cierre
  paso(3, 'Cliente confirma el cierre');
  r = await fetch(`${API}/cliente/confirmar-cierre`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: ml.token, lead_id: LEAD_ID }),
  });
  data = await r.json();
  console.log(`  HTTP ${r.status}`, JSON.stringify(data, null, 2));
  if (!r.ok) throw new Error('Falló confirmar cierre');

  // Estado del lead después de confirmar
  leadDb = db.prepare('SELECT cierre_verificacion_estado, cierre_verificado_en, comision_link_pago, comision_estado FROM leads WHERE id = ?').get(LEAD_ID);
  console.log(`\n  lead.estado después:`, leadDb);

  // ── PASO 4: disputar cierre (prueba separada) — lo hacemos opcionalmente sobre otro lead
  paso(4, 'Resumen final');
  if (data.cobro?.ok) {
    console.log(`  ✅ Cobro comisión generado`);
    console.log(`     checkout_id: ${data.cobro.checkout_id}`);
    console.log(`     link pago:   ${data.cobro.link}`);
    console.log(`     wa.me link:  ${data.cobro.whatsapp || '(sin teléfono del asesor)'}`);
  } else {
    console.log(`  ⚠️  Cobro no generado: ${data.cobro?.motivo} — ${data.cobro?.detalle || ''}`);
  }

  // Emails enviados (log en consola del servidor)
  console.log(`\n📨 Emails esperados:`);
  console.log(`  1) ${lead.email} — asunto "Confirma tu cierre — InmobIA"`);
  console.log(`  2) ${asesor.email} — asunto "Cierre confirmado — cobro de comisión InmobIA"`);

  console.log(`\n✅ Test completo`);
}

main().catch(err => {
  console.error(`\n❌ Error:`, err.message);
  process.exit(1);
});
