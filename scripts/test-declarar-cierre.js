// Solo declara el cierre (sin confirmar) para que el cliente vea el banner "pendiente"
// y pueda probar los botones reales del panel.

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

async function main() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../database/inmobia.db'));

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(LEAD_ID);
  if (!lead) throw new Error(`Lead ${LEAD_ID} no existe`);
  const asesor = db.prepare('SELECT id, email, rol, nombre FROM usuarios WHERE id = ?').get(lead.asesor_id);

  // Limpiar estado previo
  db.prepare(`UPDATE leads SET etapa = 'visita-realizada',
    cierre_declarado_en = NULL, cierre_verificacion_estado = NULL, cierre_verificado_en = NULL,
    comision_checkout_id = NULL, comision_link_pago = NULL, comision_link_creado_en = NULL,
    comision_pagada_en = NULL, comision_estado = NULL WHERE id = ?`).run(LEAD_ID);

  const tokenAsesor = jwt.sign({ id: asesor.id, email: asesor.email, rol: asesor.rol }, SECRET, { expiresIn: '1h' });

  const r = await fetch(`${API}/leads/${LEAD_ID}/cerrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenAsesor}` },
    body: JSON.stringify({ valor_cierre: VALOR_CIERRE, moneda: MONEDA }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Falló declarar cierre: ' + JSON.stringify(data));

  const ml = db.prepare('SELECT token FROM magic_links WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(LEAD_ID);
  const link = `http://localhost:5173/panel-cliente.html?token=${ml.token}&accion=confirmar-cierre&lead=${LEAD_ID}`;

  console.log('✅ Cierre declarado (pendiente de confirmar por cliente)');
  console.log('\n📧 Email enviado a:', lead.email);
  console.log('\n🔗 Abre este link para ver el banner + botones:');
  console.log('\n   ' + link + '\n');
  console.log('Resumen:', data.resumen);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
