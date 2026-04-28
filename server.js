import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });
import express from 'express';
import cors from 'cors';
import { readdirSync, mkdirSync } from 'fs';
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
const fondosDir = path.join(__dirname, '../fondos');
app.use('/fondos', express.static(fondosDir));

// Archivos HTML del frontend
app.use(express.static(path.join(__dirname, './public')));

// Recursos públicos compartidos (iconos, logos, imágenes estáticas)
app.use('/public', express.static(path.join(__dirname, '../public')));

// GET /api/fondos — lista todos los fondos disponibles
app.get('/api/fondos', (_req, res) => {
  try {
    const ext = /\.(jpg|jpeg|png|webp)$/i;
    const archivos = readdirSync(fondosDir).filter(f => ext.test(f));
    res.json(archivos.map(f => ({ nombre: f, url: `/fondos/${f}` })));
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
