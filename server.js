import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });
import express from 'express';
import cors from 'cors';
import { readdirSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs';
import { db } from './database.js';
import propiedadesRouter from './routes/propiedades.js';
import authRouter from './routes/auth.js';
import contactosRouter from './routes/contactos.js';
import emailRouter from './routes/email.js';
import leadsRouter from './routes/leads.js';
import destacadosRouter from './routes/destacados.js';
import clienteRouter from './routes/cliente.js';
import requerimientosRouter from './routes/requerimientos.js';
import pagosRouter from './routes/pagos.js';
import settingsRouter from './routes/settings.js';
import './notifications-scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
// Guardamos el cuerpo crudo en req.rawBody para verificar firmas de webhooks
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Forzar charset UTF-8 solo en respuestas de API
// Forzar charset UTF-8 solo en respuestas de API
app.use('/api', (_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// Archivos estáticos (imágenes subidas) — en producción usa volumen persistente
const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '../public/uploads');
mkdirSync(path.join(uploadsDir, 'mascotas'), { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Fondos de galería
const fondosDirPublic = path.join(__dirname, './public/fondos');
const fondosDirLegacy = path.join(__dirname, '../fondos');
const fondosDir = existsSync(fondosDirPublic) ? fondosDirPublic : fondosDirLegacy;
app.use('/fondos', express.static(fondosDir));

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absoluteUrl(req, value = '') {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}${value.startsWith('/') ? value : `/${value}`}`;
}

function formatoPrecioPreview(precio, moneda = 'GTQ', operacion = 'venta') {
  const symbol = moneda === 'USD' ? '$' : 'Q';
  const numero = new Intl.NumberFormat('es-GT', { maximumFractionDigits: 0 }).format(Number(precio || 0));
  return `${symbol}${numero}${operacion === 'renta' ? '/mes' : ''}`;
}

function imageMimeFromUrl(url = '') {
  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function descripcionPreviewPropiedad(p) {
  const specs = [
    p.nombre_proyecto,
    p.habitaciones ? `${p.habitaciones} habitaciones` : '',
    p.banos ? `${p.banos} baños` : '',
    p.parqueos ? `${p.parqueos} parqueos` : '',
    p.metros ? `${p.metros} m²` : '',
    p.precio ? formatoPrecioPreview(p.precio, p.moneda, p.operacion) : '',
  ].filter(Boolean);
  return specs.join(' · ');
}

function obtenerPropiedadPreview(id) {
  return db.prepare(`
    SELECT p.*,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal
    FROM propiedades p
    WHERE p.id = ?
  `).get(id);
}

function datosPreviewPropiedad(req, propiedad, publicPath) {
  const url = absoluteUrl(req, publicPath || `/propiedad.html?id=${propiedad.id}`);
  const image = absoluteUrl(req, propiedad.imagen_principal || '/recursos/1-exterior-1.jpg');
  const imageType = imageMimeFromUrl(image);
  const title = `${propiedad.titulo || 'Propiedad en InmobIA'}${propiedad.nombre_proyecto ? ` | ${propiedad.nombre_proyecto}` : ''}`;
  const description = descripcionPreviewPropiedad(propiedad) || 'Conoce esta propiedad disponible en InmobIA.';

  const meta = `
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="es_GT">
<meta property="og:site_name" content="InmobIA">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:secure_url" content="${escapeHtml(image)}">
<meta property="og:image:type" content="${escapeHtml(imageType)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<link rel="image_src" href="${escapeHtml(image)}">`;

  return { url, image, imageType, title, description, meta };
}

function enviarPropiedadConPreview(req, res, next, id, publicPath) {
  if (!id) return next();

  try {
    const propiedad = obtenerPropiedadPreview(id);
    if (!propiedad) return next();

    const htmlPath = path.join(__dirname, './public/propiedad.html');
    let html = readFileSync(htmlPath, 'utf8');
    const { title, meta } = datosPreviewPropiedad(req, propiedad, publicPath || `/propiedad.html?id=${id}`);

    html = html.replace(
      /<title>[\s\S]*?<\/title>/i,
      `<title>${escapeHtml(title)} — InmobIA</title>${meta}`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(html);
  } catch (err) {
    console.error('Error generando preview de propiedad:', err.message);
    next();
  }
}

// HTML dinámico para que WhatsApp/Facebook lean vista previa de cada propiedad
app.get('/compartir/propiedad/:id/:slug', (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next();

  try {
    const propiedad = obtenerPropiedadPreview(id);
    if (!propiedad) return next();

    const detailUrl = absoluteUrl(req, `/propiedad.html?id=${id}`);
    const { title, description, meta } = datosPreviewPropiedad(req, propiedad, req.originalUrl);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — InmobIA</title>${meta}
<meta http-equiv="refresh" content="1;url=${escapeHtml(detailUrl)}">
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(description)}</p>
<p><a href="${escapeHtml(detailUrl)}">Ver propiedad en InmobIA</a></p>
<script>setTimeout(function(){ window.location.replace(${JSON.stringify(detailUrl)}); }, 250);</script>
</body>
</html>`);
  } catch (err) {
    console.error('Error generando página de compartir propiedad:', err.message);
    next();
  }
});

app.get('/p/:id/:slug', (req, res, next) => {
  const id = Number(req.params.id);
  enviarPropiedadConPreview(req, res, next, id, req.originalUrl);
});

app.get('/p/:id', (req, res, next) => {
  const id = Number(req.params.id);
  const suffix = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  enviarPropiedadConPreview(req, res, next, id, `/p/${id}${suffix}`);
});

app.get('/propiedad.html', (req, res, next) => {
  const id = Number(req.query.id);
  const suffix = req.query.s ? `?s=${encodeURIComponent(req.query.s)}` : '';
  enviarPropiedadConPreview(req, res, next, id, `/p/${id}${suffix}`);
});

// Archivos HTML del frontend
app.use(express.static(path.join(__dirname, './public')));

// Recursos públicos compartidos (iconos, logos, imágenes estáticas)
app.use('/public', express.static(path.join(__dirname, '../public')));

// GET /api/fondos — lista todos los fondos disponibles
app.get('/api/fondos', (_req, res) => {
  try {
    const ext = /\.(jpg|jpeg|png|webp)$/i;
    const archivos = readdirSync(fondosDir).filter(f => ext.test(f));
    res.json(archivos.map(f => ({
      nombre: f,
      url: `/fondos/${encodeURIComponent(f)}?v=${Math.round(statSync(path.join(fondosDir, f)).mtimeMs)}`,
    })));
  } catch {
    res.json([]);
  }
});

// GET /api/tipo-cambio — tipo de cambio USD→GTQ venta (Banco Industrial)
app.get('/api/tipo-cambio', async (_req, res) => {
  try {
    const resp = await fetch(
      'https://www.corporacionbi.com/gt/bancoindustrial/wp-content/plugins/jevelin_showcase_exchange_rate/service/mod_moneda.php',
      { method: 'POST' }
    );
    const data = await resp.json();
    // data[1] = venta agencia (precio al que el banco vende USD, el cliente compra)
    const venta = parseFloat(data[1]);
    if (!venta || isNaN(venta)) throw new Error('Rate not found');
    res.json({ venta });
  } catch (err) {
    console.error('Error obteniendo tipo de cambio BI:', err.message);
    res.status(502).json({ error: 'No se pudo obtener el tipo de cambio', venta: 7.75 });
  }
});

// ── Webhook WhatsApp Cloud API (Meta) ─────────────────────────────────────
// GET /api/home-stats — métricas públicas reales del hero
app.get('/api/home-stats', (_req, res) => {
  try {
    const propiedadesActivas = db.prepare(`
      SELECT COUNT(*) AS total
      FROM propiedades
      WHERE publicado_inmobia = 1 AND estado = 'activo'
    `).get()?.total || 0;

    const cal = db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN estrellas >= 4 THEN 1 END) AS satisfechos,
        AVG(estrellas) AS promedio
      FROM calificaciones
    `).get();

    const clientesSatisfechos = cal?.satisfechos || 0;
    const calificacionPromedio = cal?.promedio ? Math.round(Number(cal.promedio) * 10) / 10 : 0;
    const visible = propiedadesActivas >= 20 && clientesSatisfechos >= 25 && calificacionPromedio >= 4.5;

    res.json({
      visible,
      propiedades_activas: propiedadesActivas,
      clientes_satisfechos: clientesSatisfechos,
      calificacion_promedio: calificacionPromedio,
      total_calificaciones: cal?.total || 0,
      fuente_calificacion: 'calificaciones.estrellas'
    });
  } catch (err) {
    console.error('Error home-stats:', err.message);
    res.status(500).json({ error: 'No se pudieron obtener las metricas' });
  }
});

import { procesarWebhookMeta } from './whatsapp.js';
const WH_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'inmobia_wh_2026';

// Verificación del webhook (GET que Meta llama al configurar)
app.get('/api/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WH_VERIFY_TOKEN) {
    console.log('[WH] Webhook verificado por Meta ✅');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Mensajes entrantes de Twilio (POST con form-urlencoded)
app.post('/api/webhook/whatsapp', (req, res) => {
  res.sendStatus(200);
  procesarWebhookMeta(req.body); // body ya parseado por express.urlencoded
});

// Rutas públicas
app.use('/api/auth', authRouter);
app.use('/api/propiedades', propiedadesRouter);
app.use('/api/contactos', contactosRouter);
app.use('/api/email', emailRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/destacados', destacadosRouter);
app.use('/api/cliente', clienteRouter);
app.use('/api/requerimientos', requerimientosRouter);
app.use('/api/pagos', pagosRouter);
app.use('/api/settings', settingsRouter);

// Portal del asesor: /asesor/:slug → sirve asesor.html y el JS lee el slug de la URL
app.get('/asesor/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, './public/asesor.html'));
});

// Manejador global de errores — siempre devuelve JSON
app.use((err, _req, res, _next) => {
  console.error('Error no manejado:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`Servidor InmobIA corriendo en http://localhost:${PORT}`);
});
