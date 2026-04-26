// Genera un PDF con el análisis de modelos de negocio InmobIA.
// Uso: node backend/scripts/generar-pdf-analisis.js
// Salida: docs/analisis-modelos-negocio.pdf

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, '../../docs');
const OUT_PATH  = path.join(OUT_DIR, 'analisis-modelos-negocio.pdf');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Paleta InmobIA ──
const NAVY   = '#1e2d4a';
const GOLD   = '#c9a84c';
const CREAM  = '#fdf8ee';
const BORDER = '#e5e2da';
const MUTED  = '#666666';
const TEXT   = '#2b2b2b';
const OK     = '#2e7d4a';
const WARN   = '#b7791f';
const BAD    = '#b83a3a';

// ── Setup doc ──
const doc = new PDFDocument({
  size: 'LETTER',
  margins: { top: 64, bottom: 60, left: 56, right: 56 },
  info: {
    Title: 'Análisis de modelos de negocio · InmobIA',
    Author: 'InmobIA',
    Subject: 'Estado de implementación y roadmap a producción',
  },
});

doc.pipe(fs.createWriteStream(OUT_PATH));

// ── Helpers ──
const PAGE_W = doc.page.width;
const MARGIN_L = doc.page.margins.left;
const MARGIN_R = doc.page.margins.right;
const USABLE_W = PAGE_W - MARGIN_L - MARGIN_R;

function hr(color = BORDER, width = 0.5) {
  const y = doc.y;
  doc.save().moveTo(MARGIN_L, y).lineTo(PAGE_W - MARGIN_R, y)
     .lineWidth(width).strokeColor(color).stroke().restore();
  doc.moveDown(0.6);
}

function h1(text) {
  ensureSpace(80);
  doc.moveDown(0.6);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text(text);
  doc.moveDown(0.15);
  const y = doc.y;
  doc.save().rect(MARGIN_L, y, 48, 2.5).fill(GOLD).restore();
  doc.moveDown(0.8);
}

function h2(text, { withBadge } = {}) {
  ensureSpace(60);
  doc.moveDown(0.5);
  const startY = doc.y;
  let badgeReservedW = 0;

  if (withBadge) {
    const padX = 6;
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9);
    const bw = doc.widthOfString(withBadge) + padX * 2;
    const bh = 14;
    const bx = PAGE_W - MARGIN_R - bw;
    const by = startY + 3;
    doc.roundedRect(bx, by, bw, bh, 3).fill(GOLD);
    doc.fillColor('#ffffff').text(withBadge, bx + padX, by + 3, { lineBreak: false, width: bw });
    doc.restore();
    badgeReservedW = bw + 12;
  }

  // Reset cursor and draw the title on the left, leaving room for the badge
  doc.x = MARGIN_L;
  doc.y = startY;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text(text, MARGIN_L, startY, {
    width: USABLE_W - badgeReservedW,
  });
  doc.moveDown(0.4);
}

function h3(text) {
  ensureSpace(40);
  doc.moveDown(0.3);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text(text);
  doc.moveDown(0.2);
}

function p(text, opts = {}) {
  doc.fillColor(TEXT).font('Helvetica').fontSize(10).text(text, {
    align: 'justify', lineGap: 2, ...opts,
  });
  doc.moveDown(0.4);
}

function bullet(text, indent = 0) {
  const x = MARGIN_L + 10 + indent;
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10).text('•', x, doc.y, { lineBreak: false, width: 10 });
  doc.fillColor(TEXT).font('Helvetica').fontSize(10).text(text, x + 12, doc.y, {
    width: USABLE_W - 12 - indent,
    lineGap: 2,
    align: 'left',
  });
  doc.moveDown(0.2);
}

function checkbox(text, done) {
  const x = MARGIN_L + 10;
  const y = doc.y + 2;
  const size = 9;
  doc.save().rect(x, y, size, size).lineWidth(0.8).strokeColor(done ? OK : '#999').stroke();
  if (done) {
    doc.moveTo(x + 1.5, y + 5).lineTo(x + 3.8, y + 7).lineTo(x + 7.5, y + 2.5)
       .lineWidth(1.4).strokeColor(OK).stroke();
  }
  doc.restore();
  doc.fillColor(TEXT).font('Helvetica').fontSize(10).text(text, x + size + 8, y - 2, {
    width: USABLE_W - size - 10,
    lineGap: 2,
  });
  doc.moveDown(0.2);
}

function ensureSpace(px) {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < px) doc.addPage();
}

function tableEstado({ title, rows, readiness }) {
  h2(title, { withBadge: readiness });
  const colW = [USABLE_W * 0.62, USABLE_W * 0.18, USABLE_W * 0.20];
  const rowH = 22;

  // Header row
  ensureSpace(rowH + rows.length * rowH + 20);
  const headerY = doc.y;
  doc.save().rect(MARGIN_L, headerY, USABLE_W, rowH).fill(NAVY).restore();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5);
  doc.text('Pieza',            MARGIN_L + 8,                         headerY + 7, { width: colW[0] - 12, lineBreak: false });
  doc.text('Estado',           MARGIN_L + colW[0] + 4,               headerY + 7, { width: colW[1] - 8,  lineBreak: false });
  doc.text('Ubicación / Nota', MARGIN_L + colW[0] + colW[1] + 4,     headerY + 7, { width: colW[2] - 8,  lineBreak: false });
  doc.x = MARGIN_L;
  doc.y = headerY + rowH;

  // Data rows
  rows.forEach((r, i) => {
    ensureSpace(rowH + 6);
    const startY = doc.y;
    const zebra = i % 2 === 0 ? '#fafaf7' : '#ffffff';
    doc.save().rect(MARGIN_L, startY, USABLE_W, rowH).fill(zebra).restore();

    doc.fillColor(TEXT).font('Helvetica').fontSize(9.5)
       .text(r[0], MARGIN_L + 8, startY + 7, { width: colW[0] - 12, lineBreak: false, ellipsis: true });

    const estadoColor = r[1] === '✅' ? OK : r[1] === '⚠️' ? WARN : r[1] === '❌' ? BAD : MUTED;
    const estadoLabel = r[1] === '✅' ? 'Listo' : r[1] === '⚠️' ? 'Parcial' : r[1] === '❌' ? 'Pendiente' : r[1];
    doc.fillColor(estadoColor).font('Helvetica-Bold').fontSize(9.5)
       .text(estadoLabel, MARGIN_L + colW[0] + 4, startY + 7, { width: colW[1] - 8, lineBreak: false });

    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
       .text(r[2] || '—', MARGIN_L + colW[0] + colW[1] + 4, startY + 7, {
         width: colW[2] - 8, lineBreak: false, ellipsis: true,
       });

    doc.x = MARGIN_L;
    doc.y = startY + rowH;
  });

  // Bottom border
  doc.save().moveTo(MARGIN_L, doc.y).lineTo(PAGE_W - MARGIN_R, doc.y)
     .lineWidth(0.5).strokeColor(BORDER).stroke().restore();
  doc.moveDown(0.8);
}

function callout(text, kind = 'info') {
  ensureSpace(60);
  const pad = 12;
  const colors = {
    info:    { bg: CREAM, border: GOLD, text: '#5a4a1a' },
    warn:    { bg: '#fff4e5', border: WARN, text: '#6b4d10' },
    danger:  { bg: '#fce8e8', border: BAD, text: '#5a1f1f' },
    success: { bg: '#e8f5ed', border: OK, text: '#204d30' },
  }[kind] || colors.info;
  const startY = doc.y;
  doc.save();
  doc.font('Helvetica').fontSize(10);
  const textH = doc.heightOfString(text, { width: USABLE_W - pad * 2 - 8, lineGap: 2 });
  const boxH = textH + pad * 2;
  doc.rect(MARGIN_L, startY, USABLE_W, boxH).fill(colors.bg);
  doc.rect(MARGIN_L, startY, 3, boxH).fill(colors.border);
  doc.fillColor(colors.text).font('Helvetica').fontSize(10)
     .text(text, MARGIN_L + pad + 4, startY + pad, {
       width: USABLE_W - pad * 2 - 4, lineGap: 2, align: 'left',
     });
  doc.restore();
  doc.y = startY + boxH;
  doc.moveDown(0.6);
}

// ──────────────────────────────────────────────
// PORTADA
// ──────────────────────────────────────────────
doc.save().rect(0, 0, PAGE_W, 180).fill(NAVY).restore();
doc.save().rect(0, 180, PAGE_W, 4).fill(GOLD).restore();

doc.fillColor('#ffffff').font('Helvetica').fontSize(11)
   .text('InmobIA · Documento interno', MARGIN_L, 60);

doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(26)
   .text('Análisis de modelos', MARGIN_L, 85);
doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(26)
   .text('de negocio', MARGIN_L, 115);

doc.fillColor('#ffffff').font('Helvetica').fontSize(11)
   .text('Estado de implementación · checklist de procesos faltantes · plan a producción', MARGIN_L, 150, {
     width: USABLE_W,
   });

doc.y = 210;
doc.fillColor(MUTED).font('Helvetica').fontSize(9)
   .text(`Generado: ${new Date().toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' })}`, MARGIN_L);
doc.moveDown(1.2);

// Resumen ejecutivo
h2('Resumen ejecutivo');
p('InmobIA opera cinco modelos de negocio coherentes entre sí. El motor público (buscador, galería, formulario de agendamiento, panel del cliente) y el panel del asesor (portal personal, subida de propiedades, CRM con pipeline, red colaborativa) están operativos. La integración con Recurrente permite activar el plan Premium de Q399/mes con reconciliación manual vía API.');
p('El progreso global ponderado es de aproximadamente 67 %. Los dos bloqueadores reales para entrar a producción son: (1) el webhook público de Recurrente — para renovaciones y downgrade automático — y (2) la facturación electrónica FEL mediante Infile, requisito legal en Guatemala para emitir comprobantes válidos.');

// Snapshot por modelo
h3('Estado por modelo');
[
  ['Modelo 1D · 50/50 · Propiedades InmobIA',   '60 %'],
  ['Modelo 2A · 30/70 · Propiedades de Asesores', '75 %'],
  ['Modelo 3S · Premium Q399/mes',                '80 %'],
  ['Modelo 4T · 40/20/40 · Tripartito',           '65 %'],
  ['Modelo 5RA · 45/5/45 · Red de Asesores',      '55 %'],
].forEach(([nombre, pct]) => {
  const rowH = 20;
  ensureSpace(rowH + 4);
  const y = doc.y;

  doc.fillColor(TEXT).font('Helvetica').fontSize(10)
     .text(nombre, MARGIN_L, y + 4, { width: USABLE_W * 0.55, lineBreak: false, ellipsis: true });

  const barX = MARGIN_L + USABLE_W * 0.58;
  const barW = USABLE_W * 0.28;
  const barY = y + 7;
  const pctNum = parseInt(pct);
  doc.save().roundedRect(barX, barY, barW, 7, 3).fill('#ece7d9').restore();
  doc.save().roundedRect(barX, barY, barW * (pctNum / 100), 7, 3).fill(GOLD).restore();

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10)
     .text(pct, barX + barW + 8, y + 4, { lineBreak: false, width: 50 });

  doc.x = MARGIN_L;
  doc.y = y + rowH;
});

// ──────────────────────────────────────────────
// ESTADO ACTUAL POR MODELO
// ──────────────────────────────────────────────
doc.addPage();
h1('Estado actual por modelo');

tableEstado({
  title: 'Modelo 1D · 50/50 · Propiedades de InmobIA',
  readiness: '60 % listo',
  rows: [
    ['Detección automática cuando la propiedad es de admin', '✅', 'lib/modelos.js'],
    ['Split 50/50 al cerrar',                                  '✅', 'lib/modelos.js'],
    ['Panel admin para cargar propiedades de Inmobia',         '✅', 'admin.html'],
    ['Asignación de asesor interno al lead 1D',                '❌', 'flujo ausente'],
    ['Flujo de pago de comisión al asesor interno',            '❌', 'flujo ausente'],
    ['Reporte por asesor interno (ranking de cierres)',        '❌', 'flujo ausente'],
  ],
});

tableEstado({
  title: 'Modelo 2A · 30/70 · Propiedades de Asesores',
  readiness: '75 % listo',
  rows: [
    ['Subida de propiedades por asesor',                 '✅', 'routes/propiedades.js'],
    ['Toggle publicado_inmobia por propiedad',           '✅', 'database.js'],
    ['Comisión configurable por propiedad (admin)',      '✅', 'database.js'],
    ['Captura de lead + sello de modelo=2A',             '✅', 'routes/contactos.js'],
    ['Split 30/70 al marcar cerrado',                    '✅', 'routes/leads.js'],
    ['Cobro real del 30 % al asesor (link Recurrente)',  '❌', 'bloqueante'],
    ['Verificación doble (cliente confirma cierre)',     '❌', 'bloqueante'],
    ['Factura FEL de la comisión',                       '❌', 'bloqueante'],
  ],
});

tableEstado({
  title: 'Modelo 3S · Premium Q399/mes',
  readiness: '80 % listo',
  rows: [
    ['Producto creado en Recurrente',                       '✅', 'prod_s8vxqbuh'],
    ['Checkout desde panel con metadata.usuario_id',        '✅', 'routes/pagos.js'],
    ['Reconciliación manual por API',                       '✅', 'routes/pagos.js'],
    ['Correo de bienvenida Premium',                        '✅', 'email.js'],
    ['UI con fecha de renovación',                          '✅', 'panel-asesor.html'],
    ['Webhook público (ngrok o prod)',                      '❌', 'prioritario'],
    ['Recordatorio 3 días antes de renovar',                '❌', 'cron pendiente'],
    ['Downgrade automático a Gratis por impago (día 5)',    '❌', 'cron pendiente'],
    ['Suspensión de leads al día 10',                       '❌', 'cron pendiente'],
    ['Factura FEL del Premium',                             '❌', 'bloqueante'],
  ],
});

tableEstado({
  title: 'Modelo 4T · 40/20/40 · Tripartito',
  readiness: '65 % listo',
  rows: [
    ['Toggle por asesor para mostrar propiedades de otros',  '✅', 'database.js'],
    ['Toggle compartir_tripartito por propiedad',            '✅', 'database.js'],
    ['referente_slug al agendar → sella modelo=4T',          '✅', 'routes/contactos.js'],
    ['Correos al captor y al referente',                     '✅', 'routes/contactos.js'],
    ['Doble firma digital del convenio',                     '✅', 'routes/leads.js'],
    ['Split 40/20/40 al cerrar',                             '✅', 'lib/modelos.js'],
    ['Validar que Asesor 2 es Premium al compartir',         '⚠️', 'parcial'],
    ['PDF del convenio tripartito firmado',                  '❌', 'pendiente'],
    ['Cobro de la comisión a ambos asesores',                '❌', 'bloqueante'],
    ['Cláusula anti-contacto (bloqueo técnico)',             '❌', 'pendiente'],
  ],
});

tableEstado({
  title: 'Modelo 5RA · 45/5/45 · Red de Asesores',
  readiness: '55 % listo',
  rows: [
    ['Publicar requerimiento (solo Premium)',               '✅', 'routes/requerimientos.js'],
    ['Lista de requerimientos activos para la red',         '✅', 'routes/requerimientos.js'],
    ['Responder con propiedad → crea lead 5RA',             '✅', 'routes/requerimientos.js'],
    ['Email al autor cuando alguien responde',              '✅', 'routes/requerimientos.js'],
    ['Renovar +3 días / cerrar',                            '✅', 'routes/requerimientos.js'],
    ['Split 45/5/45 al cerrar',                             '✅', 'lib/modelos.js'],
    ['Match automático requerimiento ↔ propiedad existente','❌', 'pendiente'],
    ['Notificación WhatsApp + in-app al día 3',             '❌', 'pendiente'],
    ['PDF del convenio 45/5/45',                            '❌', 'pendiente'],
    ['Cobro a ambos asesores al cerrar',                    '❌', 'bloqueante'],
  ],
});

// ──────────────────────────────────────────────
// CHECKLIST TRANSVERSAL
// ──────────────────────────────────────────────
doc.addPage();
h1('Procesos faltantes — checklist transversal');

h3('A. Pagos y comisiones · bloquea el ingreso variable');
[
  ['Webhook público de Recurrente (ngrok en dev, dominio en prod)', false],
  ['Endpoint "declarar cierre" con validación del cliente', false],
  ['Generación de link Recurrente para cobro de comisión puntual', false],
  ['Cobro automático a tarjeta registrada (asesores Premium)', false],
  ['Protocolo de incumplimiento (día 0 → 3 → 5 → 10)', false],
  ['Reintento automático de cobro Premium fallido', false],
].forEach(([t, d]) => checkbox(t, d));

h3('B. Facturación SAT · bloquea el lado legal');
[
  ['Integración Infile FEL', false],
  ['Captura de NIT/CUI en registro (columna ya existe en DB)', false],
  ['Emisión automática de factura Premium mensual', false],
  ['Emisión automática de factura de comisión por cierre', false],
  ['Panel del asesor con historial descargable de facturas', false],
].forEach(([t, d]) => checkbox(t, d));

h3('C. Score dinámico · bloquea la calidad del match');
[
  ['Cálculo del score con la fórmula 50/30/20 (3 meses móviles)', false],
  ['Eventos que suben/bajan score (cada acción)', false],
  ['Badges públicos (Verificado / Destacado / Élite)', false],
  ['Niveles con beneficios (leads/mes por nivel)', false],
  ['Detección de cierres no declarados (−0.8★)', false],
].forEach(([t, d]) => checkbox(t, d));

h3('D. Seguimiento automatizado · 5 capas');
[
  ['Capa 1 — recordatorio 24h antes de visita (cron)', false],
  ['Capa 1 — encuesta post-visita a cliente y asesor', false],
  ['Capa 2 — alerta si asesor no actualiza lead en 48h', false],
  ['Capa 3 — reactivación del cliente cada 2 semanas', false],
  ['Capa 4 — pregunta al cliente a los 7 días', false],
  ['Capa 5 — score penaliza ausencia de bitácora', false],
].forEach(([t, d]) => checkbox(t, d));

h3('E. Red colaborativa · mejoras');
[
  ['Motor de match automático requerimiento ↔ propiedad', false],
  ['Chat interno entre asesores en un lead 4T/5RA', false],
  ['WhatsApp de renovación al día 3', false],
  ['Panel de "mis colaboraciones activas"', false],
].forEach(([t, d]) => checkbox(t, d));

h3('F. Infraestructura y producción');
[
  ['Dominio + HTTPS (inmobia.com)', false],
  ['Deploy backend (Render / Railway / VPS con PM2)', false],
  ['Deploy frontend (Netlify / Vercel o mismo host)', false],
  ['Backups automáticos de SQLite o migración a PostgreSQL', false],
  ['Variables de entorno de producción (claves LIVE, JWT fuerte)', false],
  ['Rate limiting en rutas sensibles (express-rate-limit)', false],
  ['CORS restringido al dominio propio', false],
  ['Logs estructurados + monitoreo (pino + Sentry/Logtail)', false],
  ['Email transaccional robusto (migrar a Resend/SendGrid)', false],
].forEach(([t, d]) => checkbox(t, d));

h3('G. Legal y confianza');
[
  ['Términos y condiciones definitivos (revisar terminos.html)', false],
  ['Política de privacidad (Ley de datos GT)', false],
  ['Convenios en PDF firmable (4T y 5RA)', false],
  ['Cláusula anti-contacto con cliente de la contraparte', false],
].forEach(([t, d]) => checkbox(t, d));

h3('H. Panel admin InmobIA');
[
  ['Dashboard ejecutivo (MRR Premium, cierres, comisiones)', false],
  ['Vista de leads 1D con asignación a asesor interno', false],
  ['Moderación de propiedades (aprobar/rechazar)', false],
  ['Listado de asesores por score/estado', false],
  ['Auditoría de pagos (bitácora pagos)', false],
].forEach(([t, d]) => checkbox(t, d));

// ──────────────────────────────────────────────
// PLAN DE PRIORIDADES
// ──────────────────────────────────────────────
doc.addPage();
h1('Plan de prioridades para salir a producción');

h2('Sprint 1 · Cerrar el ciclo del dinero', { withBadge: '1–2 semanas' });
p('Es lo único que bloquea cobrar — sin esto la plataforma no genera ingresos por comisión ni puede facturar legalmente.');
[
  'Exponer backend con ngrok y registrar webhook de Recurrente → eliminar reconciliación manual',
  'Endpoint "declarar cierre" con doble verificación del cliente',
  'Generación de link Recurrente de comisión puntual (Modelo 2A) + correo/WhatsApp al asesor',
  'Integración Infile FEL básica → factura Premium + factura de comisión',
  'Captura de NIT en registro y en perfil del asesor',
].forEach(t => bullet(t));

h2('Sprint 2 · Producción mínima viable', { withBadge: '1 semana' });
[
  'Dominio + HTTPS + deploy backend y frontend',
  'Claves LIVE de Recurrente (salir de modo test)',
  'Migrar email transaccional a Resend o SendGrid',
  'Backups automáticos nocturnos de la base de datos',
  'Rate limiting + CORS estricto + JWT secret robusto',
].forEach(t => bullet(t));

h2('Sprint 3 · Retener asesores Premium', { withBadge: '1–2 semanas' });
[
  'Cron de renovaciones: notificación 3 días antes del cobro',
  'Protocolo de impago (día 3, 5, 10 → downgrade a Gratis)',
  'Score dinámico v1 con la fórmula 50/30/20 (promedio móvil 3 meses)',
  'Badges públicos en el portal /asesor/slug',
].forEach(t => bullet(t));

h2('Sprint 4 · Calidad del match', { withBadge: '2 semanas' });
[
  'Match automático requerimiento ↔ propiedad (Modelo 5RA)',
  'Capa 1 del seguimiento automatizado (recordatorios + encuesta post-visita)',
  'Capa 4 (pregunta al cliente a los 7 días: ¿encontraste tu propiedad?)',
  'Chat interno en leads 4T y 5RA',
  'PDF firmado del convenio tripartito',
].forEach(t => bullet(t));

h2('Sprint 5 · Escala y operación', { withBadge: 'continuo' });
[
  'Dashboard admin con MRR Premium + comisiones por modelo',
  'Capas 2, 3 y 5 del seguimiento automatizado',
  'Migración SQLite → PostgreSQL si el tráfico lo exige',
  'Monitoreo con Sentry/Logtail y alertas',
].forEach(t => bullet(t));

// ──────────────────────────────────────────────
// CUELLO DE BOTELLA
// ──────────────────────────────────────────────
doc.addPage();
h1('El cuello de botella real');

p('Hoy la plataforma puede captar clientes, asignarlos a asesores y activar Premium. Lo que no puede es cobrar la comisión por cierre ni emitir facturas SAT — eso bloquea toda la Capa 1 del modelo (30 %, 20 %, 5 %), que es donde vive el upside real del negocio.');

p('Sin esas dos piezas, la plataforma funciona pero no genera ingresos variables y no es legal facturar en Guatemala. Por eso el Sprint 1 (webhook + declarar cierre + Infile) es el desbloqueador real: al terminarlo, InmobIA puede facturar su primer quetzal. Todo lo demás — score, automatizaciones, match automático, mejoras de UX — mejora la experiencia pero no impide salir al aire.');

callout('Recomendación: arrancar Sprint 1 en paralelo con registro legal en Infile (trámite con el certificador SAT toma entre 3 y 5 días hábiles en Guatemala).', 'info');

h3('Riesgos clave a mitigar antes del lanzamiento');
bullet('Webhook inaccesible: activar ngrok en dev y configurar dominio con HTTPS válido antes de pasar a claves LIVE.');
bullet('Gmail SMTP podría rate-limitar en volumen alto: migrar a Resend o SendGrid antes de tener más de 50 asesores activos.');
bullet('SQLite con WAL es suficiente para arranque, pero planificar migración a PostgreSQL al llegar a ~500 usuarios concurrentes.');
bullet('El score dinámico debe estar calibrado antes de abrir la red colaborativa públicamente, para evitar ranking injusto en los primeros cierres.');

// ── Footer en todas las páginas ──
const pages = doc.bufferedPageRange ? doc.bufferedPageRange() : { start: 0, count: 0 };
// pdfkit sin bufferPages=true no permite iterar; lo añadimos después.

doc.end();

doc.on('end', () => {
  console.log(`✅ PDF generado: ${OUT_PATH}`);
  console.log(`   Tamaño: ${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB`);
});
