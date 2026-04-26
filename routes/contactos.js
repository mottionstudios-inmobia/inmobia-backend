import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import crypto from 'crypto';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';
import { crearTransporter } from '../email.js';
import { detectarModelo, MODELOS } from '../lib/modelos.js';
import { sendWhatsApp } from '../whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mascotaDir = path.join(__dirname, '../../public/uploads/mascotas');
mkdirSync(mascotaDir, { recursive: true });

const uploadMascota = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, mascotaDir),
    filename: (req, file, cb) => cb(null, `mascota_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /jpeg|jpg|png|webp/i.test(file.mimetype)),
});

const router = Router();

// ── POST /api/contactos  (pública — formulario del portal del asesor)
router.post('/', uploadMascota.array('fotos_mascota', 5), async (req, res) => {
  const {
    propiedad_id, nombre, telefono, email, mensaje, asesor_id, asesor_slug, tipo, fecha, interes,
    operacion, tipo_propiedad, zona, presupuesto, metros, habitaciones, banos, parqueos,
    caracteristicas, mascota, desc_mascota, origen, referente_slug, requerimiento_id,
    dias, horario, dia_hora, propiedad_url
  } = req.body;

  // Detectar modelo de negocio (1D, 2A, 4T, 5RA) — el árbitro oficial
  const modelo = detectarModelo({
    propiedadId: propiedad_id ? Number(propiedad_id) : null,
    referenteSlug: referente_slug || null,
    requerimientoId: requerimiento_id ? Number(requerimiento_id) : null,
  });

  // Modelo tripartito: si viene referente_slug, resolver el asesor referente (quien tiene al cliente en su portal)
  let asesor_referente_id = null;
  let esTripartito = false;
  if (referente_slug) {
    const ref = db.prepare('SELECT id FROM usuarios WHERE slug = ? AND rol = ?').get(referente_slug, 'asesor');
    if (ref && ref.id !== Number(asesor_id)) {
      asesor_referente_id = ref.id;
      esTripartito = true;
    }
  }

  if (!nombre && !telefono && !email)
    return res.status(400).json({ error: 'Incluye al menos un dato de contacto' });

  // 1. Guardar en tabla contactos (historial general)
  db.prepare(`
    INSERT INTO contactos (propiedad_id, nombre, telefono, email, mensaje)
    VALUES (?, ?, ?, ?, ?)
  `).run(propiedad_id || null, nombre || null, telefono || null, email || null, mensaje || null);

  // 2. Si viene con asesor_id → crear lead en CRM del asesor
  if (asesor_id) {
    // Título de la propiedad
    let propiedadTitulo = interes || null;
    if (!propiedadTitulo && (tipo_propiedad || zona || operacion)) {
      propiedadTitulo = [operacion, tipo_propiedad, zona].filter(Boolean).join(' · ') || 'Búsqueda personalizada';
    }
    if (propiedad_id && !propiedadTitulo) {
      const prop = db.prepare('SELECT titulo FROM propiedades WHERE id = ?').get(propiedad_id);
      if (prop) propiedadTitulo = prop.titulo;
    }

    // Datos estructurados del formulario de búsqueda
    const datosExtra = JSON.stringify({
      operacion:      operacion      || '',
      tipo_propiedad: tipo_propiedad || '',
      zona:           zona           || '',
      presupuesto:    presupuesto    || '',
      metros:         metros         || '',
      habitaciones:   habitaciones   || '',
      banos:          banos          || '',
      parqueos:       parqueos       || '',
      caracteristicas:caracteristicas|| '',
      mascota:        mascota        || '',
      desc_mascota:   desc_mascota   || '',
      dias:           dias           || '',
      horario:        horario        || '',
      dia_hora:       dia_hora       || '',
      propiedad_url:  propiedad_url  || '',
    });

    const origenFinal = esTripartito ? 'tripartito' : (origen || 'portal');
    // Modelo tripartito: el lead es propiedad del captor (dueño de la propiedad y del cierre).
    // asesor_referente_id guarda al referente (trae al cliente). El referente ve el lead como vista espejo.
    const leadOwnerId    = Number(asesor_id);
    const leadPartnerId  = esTripartito ? asesor_referente_id : null;
    db.prepare(`
      INSERT INTO leads (asesor_id, nombre, email, telefono, mensaje, tipo, propiedad_id, propiedad_titulo, fecha_visita, origen, etapa, datos_extra, asesor_referente_id, modelo, requerimiento_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nuevo', ?, ?, ?, ?)
    `).run(
      leadOwnerId,
      nombre        || null,
      email         || null,
      telefono      || null,
      mensaje       || null,
      tipo          || 'mensaje',
      propiedad_id  || null,
      propiedadTitulo || null,
      fecha         || null,
      origenFinal,
      datosExtra,
      leadPartnerId,
      modelo,
      requerimiento_id ? Number(requerimiento_id) : null
    );
    const nuevoLeadId = db.prepare('SELECT last_insert_rowid() AS id').get()?.id;

    // 3. Enviar email de notificación al asesor captor (dueño de la propiedad)
    try {
      const asesor = db.prepare('SELECT nombre, email, slug, codigo_asesor FROM usuarios WHERE id = ?').get(asesor_id);
      if (asesor?.email) {
        const transporter = crearTransporter();
        const refInfo = esTripartito ? db.prepare('SELECT nombre, telefono, email, slug, codigo_asesor FROM usuarios WHERE id = ?').get(asesor_referente_id) : null;
        const propFull = propiedad_id ? db.prepare('SELECT titulo, habitaciones, banos, parqueos, metros FROM propiedades WHERE id = ?').get(propiedad_id) : null;

        const adjuntos = (req.files || []).map(f => ({
          filename: f.originalname,
          path: f.path,
          contentType: f.mimetype,
        }));

        let html, subject;
        if (esTripartito) {
          html = htmlCaptorTripartito({
            captorNombre: asesor.nombre, refInfo, prop: propFull, propiedadTitulo, propiedadUrl: propiedad_url,
            nombre, telefono, email, mensaje, dias, horario, diaHora: dia_hora, fecha,
          });
          subject = `🤝 Cliente tripartito — Nuevo lead desde tu portal — ${nombre || 'Cliente'}`;
        } else {
          // Modelo 2A — el asesor NO recibe datos de contacto del cliente
          // Toda la comunicación es por el panel InmobIA
          const prop2A = propiedad_id
            ? db.prepare('SELECT titulo, nombre_proyecto, habitaciones, banos, parqueos, metros, precio, moneda, zona, operacion, tipo FROM propiedades WHERE id = ?').get(propiedad_id)
            : null;

          // Filtrar mensaje si contiene teléfono
          const tieneTel = mensaje && /(\+?502[\s\-]?)?[\d]{4}[\s\-]?[\d]{4}/.test(mensaje);
          const mensajeLimpio = tieneTel ? null : mensaje;

          html = htmlNotificacion2A({
            asesorNombre: asesor.nombre,
            clienteNombre: nombre,
            prop: prop2A,
            propiedadTitulo,
            diaHora: dia_hora,
            dias,
            horario,
            mensaje: mensajeLimpio,
            propiedadUrl: propiedad_url,
          });
          subject = `🔔 Nuevo lead InmobIA (2A) — ${nombre || 'Cliente'} — ${propiedadTitulo || 'Propiedad'}`;
        }

        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: asesor.email,
          subject,
          html,
          attachments: adjuntos,
        });
      }
    } catch (err) {
      // El email falla silenciosamente — el lead ya fue creado
      console.error('Error enviando notificación al asesor:', err.message);
    }

    // Modelo tripartito: notificar también al asesor referente (quien tiene al cliente)
    if (esTripartito && asesor_referente_id) {
      try {
        const asesorRef  = db.prepare('SELECT nombre, email, slug, codigo_asesor FROM usuarios WHERE id = ?').get(asesor_referente_id);
        const asesorProp = db.prepare('SELECT nombre, telefono, email, slug, codigo_asesor FROM usuarios WHERE id = ?').get(asesor_id);
        const propFullRef = propiedad_id ? db.prepare('SELECT titulo, habitaciones, banos, parqueos, metros FROM propiedades WHERE id = ?').get(propiedad_id) : null;
        if (asesorRef?.email) {
          const transporter = crearTransporter();
          await transporter.sendMail({
            from: `"InmobIA" <${process.env.SMTP_USER}>`,
            to: asesorRef.email,
            subject: `🤝 Cliente tripartito — Lead generado desde su portal`,
            html: htmlReferenteTripartito({
              refNombre: asesorRef.nombre, captor: asesorProp, prop: propFullRef, propiedadTitulo, propiedadUrl: propiedad_url,
              nombre, telefono, email, mensaje, dias, horario, diaHora: dia_hora, fecha,
            }),
          });
        }
      } catch (err) { console.error('Error notificando referente tripartito:', err.message); }
    }
  }

  // 4. Magic link + email de confirmación al cliente (solo si tiene email)
  let magic_url = null;
  if (email && asesor_id) {
    try {
      const leadRow = db.prepare('SELECT id FROM leads WHERE asesor_id = ? AND email = ? ORDER BY id DESC LIMIT 1').get(Number(asesor_id), email);
      if (leadRow) {
        // Determinar expiración según tipo de operación de la propiedad
        let propTitulo = 'la propiedad';
        let propOperacion = operacion || '';
        let propProyecto = '';
        let propHabs = '';
        let propPrecio = '';
        if (propiedad_id) {
          const p = db.prepare('SELECT titulo, operacion, nombre_proyecto, habitaciones, precio, moneda FROM propiedades WHERE id = ?').get(propiedad_id);
          if (p) {
            propTitulo    = p.titulo     || propTitulo;
            propOperacion = p.operacion  || propOperacion;
            propProyecto  = p.nombre_proyecto || '';
            propHabs      = p.habitaciones ? `${p.habitaciones} hab.` : '';
            const sym     = p.moneda === 'USD' ? '$' : 'Q';
            propPrecio    = p.precio ? `${sym}${Number(p.precio).toLocaleString('es-GT')}` : '';
          }
        }
        const esRenta = propOperacion === 'renta';
        const diasExpira = esRenta ? 30 : 180; // renta: 30 días · compra/venta: 6 meses

        const token  = crypto.randomBytes(32).toString('hex');
        const expira = new Date(Date.now() + diasExpira * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare('INSERT OR IGNORE INTO magic_links (token, email, lead_id, expira_en) VALUES (?, ?, ?, ?)').run(token, email, leadRow.id, expira);
        magic_url = `${BASE_URL}/panel-cliente.html?token=${token}`;

        // Email de confirmación al cliente
        const transporter = crearTransporter();
        await transporter.sendMail({
          from: `"InmobIA" <${process.env.SMTP_USER}>`,
          to: email,
          subject: '✅ Solicitud recibida — Tu panel de seguimiento en InmobIA',
          html: htmlConfirmacionCliente({ nombre, propTitulo, magicUrl: magic_url, esRenta }),
        });

        // WhatsApp de confirmación al cliente — Modelo 2A
        if (telefono) {
          const primerNombre   = (nombre || 'Cliente').split(' ')[0];
          const lineaPropiedad = [propTitulo, propProyecto].filter(Boolean).join(' - ');
          const lineaDetalles  = [propHabs, propPrecio].filter(Boolean).join(' - ');
          const lineaVisita    = dia_hora
            ? `\nEn este momento está coordinando con el propietario el horario solicitado\npara el ${dia_hora}`
            : '';
          const bloqueWApago = esRenta ? `

📋 *INSTRUCCIONES DE PAGO — Cliente InmobIA*
Al momento de firmar el contrato recibirá las instrucciones de pago. El proceso es el siguiente:
• *30% del depósito* → pago directo a InmobIA (link de pago o transferencia)
• *70% del depósito* → pago directo al propietario
• *100% primera renta* → pago directo al propietario

InmobIA le enviará el link de pago en el momento indicado. No realice ningún pago sin recibir instrucciones oficiales de InmobIA.` : '';

          const msgWA =
`*¡Hola ${primerNombre}!* ✅ Su solicitud de visita para:
${lineaPropiedad}${lineaDetalles ? `\n${lineaDetalles}` : ''}
¡Fue recibida correctamente!

El asesor le contactará a la brevedad para confirmar la visita.${lineaVisita}${bloqueWApago}

Puede ver el estado de su solicitud en su panel personal de InmobIA:
${magic_url}
*Guarde este enlace para hacer sus consultas sobre la propiedad de su interés*`;
          sendWhatsApp(telefono, msgWA, nuevoLeadId).catch(() => {});
        }
      }
    } catch(e) { console.error('Error generando magic link/email cliente:', e.message); }
  }

  res.status(201).json({ mensaje: 'Contacto registrado', magic_url });
});

// ── GET /api/contactos  (protegida — panel admin)
router.get('/', authMiddleware, (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const contactos = db.prepare(
    'SELECT * FROM contactos ORDER BY creado_en DESC LIMIT ? OFFSET ?'
  ).all(Number(limit), Number(offset));
  const total = db.prepare('SELECT COUNT(*) as total FROM contactos').get().total;
  res.json({ total, contactos });
});

// ── DELETE /api/contactos/:id  (protegida)
router.delete('/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM contactos WHERE id = ?').run(req.params.id);
  res.json({ mensaje: 'Contacto eliminado' });
});

// ── Helpers ──
const tdL = 'padding:8px 12px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;white-space:nowrap;font-size:0.85rem';
const tdR = 'padding:8px 12px;color:#444;border-bottom:1px solid #e5e2da;font-size:0.85rem';

function waLink(tel, texto) {
  const digits = String(tel || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(texto || '')}`;
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

function bloqueModeloTripartito(role, partnerName, partnerPortal, partnerCodigo) {
  const partner = partnerName || 'el asesor socio';
  const codigoTxt = partnerCodigo ? ` · Cód. ${partnerCodigo}` : '';
  const portalTxt = partnerPortal ? `<br><a href="${partnerPortal}" style="color:#c9a84c;font-weight:600;text-decoration:none">${partnerPortal}</a>` : '';
  const roleLabel = role === 'captor' ? 'Asesor referente' : 'Asesor captor';
  const encabezado = role === 'captor'
    ? `Este cliente fue generado por <strong>${partner}</strong> desde su portal. Usted tiene la propiedad; el modelo tripartito aplica al cierre.`
    : `Este lead surgió de una propiedad compartida por <strong>${partner}</strong> en la red InmobIA. Usted trae al cliente; el modelo tripartito aplica al cierre.`;
  return `
    <div style="margin:18px 32px 4px;padding:14px 16px;background:#fff7e3;border-left:3px solid #c9a84c;border-radius:6px;font-size:0.82rem;color:#1e2d4a;line-height:1.5">
      <p style="margin:0 0 8px;font-weight:600">🤝 Modelo tripartito InmobIA</p>
      <p style="margin:0 0 10px;color:#444">${encabezado}</p>
      <p style="margin:0 0 10px;color:#444"><strong>${roleLabel}:</strong> ${partner}${codigoTxt}${portalTxt}</p>
      <p style="margin:0;color:#444">Distribución de porcentajes de comisión al cierre:</p>
      <ul style="margin:6px 0 0;padding-left:18px;color:#444">
        <li><strong>40%</strong> asesor captor (dueño de la propiedad)</li>
        <li><strong>40%</strong> asesor referente (trae al cliente)</li>
        <li><strong>20%</strong> InmobIA</li>
      </ul>
    </div>`;
}

function htmlCaptorTripartito({ captorNombre, refInfo, prop, propiedadTitulo, propiedadUrl, nombre, telefono, email, mensaje, dias, horario, diaHora, fecha }) {
  const titulo = prop?.titulo || propiedadTitulo || 'Propiedad';
  const specs = [];
  if (prop?.habitaciones) specs.push(`${prop.habitaciones} hab.`);
  if (prop?.banos)        specs.push(`${prop.banos} baños`);
  if (prop?.parqueos)     specs.push(`${prop.parqueos} parq.`);
  if (prop?.metros)       specs.push(`${prop.metros} m²`);
  const specsLinea = specs.join(' · ');
  const urlProp = propiedadUrl || '';

  const refNombre  = refInfo?.nombre || 'asesor socio';
  const refCodigo  = refInfo?.codigo_asesor ? ` · Cód. ${refInfo.codigo_asesor}` : '';
  const refPortal  = refInfo?.slug ? `${BASE_URL}/asesor.html?slug=${refInfo.slug}` : '';
  const waRefHref  = refInfo?.telefono
    ? waLink(refInfo.telefono, `*Hola ${refInfo.nombre || ''},* soy ${captorNombre || 'tu socio InmobIA'}, recibí tu solicitud de visita para mi propiedad *"${titulo}"* con tu cliente ${nombre || ''}. Gracias por traerme al cliente, *¿Te parece si coordinamos la visita?*`)
    : '';

  const reporteFilas = [
    nombre    && `<div style="margin-bottom:10px"><strong>Nombre:</strong> ${nombre}</div>`,
    (dias || horario) && `<div style="margin-bottom:10px"><strong>Días disponibles para visita</strong><br>${dias || '—'}${horario ? ` · ${horario}` : ''}</div>`,
    diaHora   && `<div style="margin-bottom:10px"><strong>Día y hora preferidos</strong><br>${diaHora}</div>`,
    fecha && !diaHora && `<div style="margin-bottom:10px"><strong>Fecha de visita</strong><br>${fecha}</div>`,
    mensaje   && `<div style="margin-bottom:0"><strong>Comentario</strong><br>${mensaje}</div>`,
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:24px 32px;vertical-align:middle">
          <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Modelo tripartito · Solicitud de visita</p>
          <h1 style="margin:0;color:#fff;font-size:1.2rem;font-weight:600">Nuevo lead desde tu portal</h1>
        </td>
        <td style="padding:24px 32px 24px 0;vertical-align:middle;text-align:right;white-space:nowrap">
          <span style="font-size:1.5rem;font-weight:300;color:#fff">Inmob</span><span style="font-size:1.7rem;font-weight:400;color:#c9a84c">IA</span>
        </td>
      </tr></table>
    </div>

    <div style="padding:22px 32px 4px">
      <p style="margin:0 0 18px;font-size:0.92rem;color:#444">Hola <strong>${captorNombre || ''}</strong>, tienes un nuevo cliente interesado por medio del modelo tripartito.</p>
    </div>

    <div style="padding:0 32px 18px">
      <h2 style="margin:0 0 6px;font-size:1.1rem;color:#1e2d4a">Propiedad de interés</h2>
      <p style="margin:0 0 4px;font-size:0.95rem;color:#1e2d4a">${titulo}</p>
      ${specsLinea ? `<p style="margin:0 0 6px;font-size:0.85rem;color:#666">${specsLinea}</p>` : ''}
      ${urlProp ? `<p style="margin:0"><a href="${urlProp}" style="color:#c9a84c;font-size:0.85rem;text-decoration:none">Ver propiedad →</a></p>` : ''}
    </div>

    <div style="margin:0 32px 20px;border:2px solid #1e2d4a;border-radius:10px;padding:18px 20px">
      <h2 style="margin:0 0 14px;font-size:1.05rem;color:#1e2d4a">Reporte del cliente</h2>
      <div style="font-size:0.88rem;color:#444;line-height:1.5">${reporteFilas || '<em style="color:#888">Sin datos adicionales</em>'}</div>
    </div>

    <div style="margin:18px 32px 4px;padding:14px 16px;background:#fff7e3;border-left:3px solid #c9a84c;border-radius:6px;font-size:0.82rem;color:#1e2d4a;line-height:1.5">
      <p style="margin:0 0 8px;font-weight:600">🤝 Modelo tripartito InmobIA</p>
      <p style="margin:0 0 14px;color:#444">Un asesor te ha traído un cliente interesado en tu propiedad. El modelo tripartito aplica al cierre.</p>
      <p style="margin:0 0 4px;color:#444">Distribución de porcentajes de comisión al cierre:</p>
      <ul style="margin:6px 0 0;padding-left:18px;color:#444">
        <li><strong>40%</strong> asesor captor (dueño de la propiedad)</li>
        <li><strong>40%</strong> asesor referente (trae al cliente)</li>
        <li><strong>20%</strong> InmobIA</li>
      </ul>
    </div>

    <div style="margin:0 32px 8px;padding:14px 16px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;font-size:0.82rem;color:#444;line-height:1.5">
      <p style="margin:0 0 6px;font-weight:600;color:#065f46">Siguiente paso</p>
      <p style="margin:0">Ingresa a tu CRM para revisar el lead y aceptar el convenio de colaboración. Los datos de contacto del asesor colega estarán disponibles una vez que ambos firmen el convenio.</p>
    </div>

    <div style="padding:18px 32px 28px;text-align:center">
      <a href="${BASE_URL}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a>
    </div>

    <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente al recibir un nuevo lead tripartito
    </div>
  </div>
</body></html>`;
}

function htmlReferenteTripartito({ refNombre, captor, prop, propiedadTitulo, propiedadUrl, nombre, telefono, email, mensaje, dias, horario, diaHora, fecha }) {
  const titulo = prop?.titulo || propiedadTitulo || 'Propiedad';
  const specs = [];
  if (prop?.habitaciones) specs.push(`${prop.habitaciones} hab.`);
  if (prop?.banos)        specs.push(`${prop.banos} baños`);
  if (prop?.parqueos)     specs.push(`${prop.parqueos} parq.`);
  if (prop?.metros)       specs.push(`${prop.metros} m²`);
  const specsLinea = specs.join(' · ');
  const urlProp = propiedadUrl || '';

  const capNombre = captor?.nombre || 'asesor socio';
  const capCodigo = captor?.codigo_asesor ? ` · Cód. ${captor.codigo_asesor}` : '';
  const capPortal = captor?.slug ? `${BASE_URL}/asesor.html?slug=${captor.slug}` : '';
  const waCapHref = captor?.telefono
    ? waLink(captor.telefono, `*Hola ${captor.nombre || ''},* soy ${refNombre || 'tu socio InmobIA'}, tengo un cliente interesado en tu propiedad *"${titulo}"*. Gracias por compartir, *¿Te parece si coordinamos la visita?*`)
    : '';

  const clienteFilas = [
    nombre    && `<div style="margin-bottom:10px"><strong>Nombre:</strong> ${nombre}</div>`,
    telefono  && `<div style="margin-bottom:10px"><strong>WhatsApp:</strong> ${telefono}</div>`,
    email     && `<div style="margin-bottom:10px"><strong>Correo electrónico:</strong> ${email}</div>`,
    (dias || horario) && `<div style="margin-bottom:10px"><strong>Días disponibles para visita</strong><br>${dias || '—'}${horario ? ` · ${horario}` : ''}</div>`,
    diaHora   && `<div style="margin-bottom:10px"><strong>Día y hora preferidos</strong><br>${diaHora}</div>`,
    fecha && !diaHora && `<div style="margin-bottom:10px"><strong>Fecha de visita</strong><br>${fecha}</div>`,
    mensaje   && `<div style="margin-bottom:0"><strong>Comentario</strong><br>${mensaje}</div>`,
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:24px 32px;vertical-align:middle">
          <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">🤝 Modelo tripartito · Su cliente está interesado en una propiedad compartida</p>
          <h1 style="margin:0;color:#fff;font-size:1.2rem;font-weight:600">Nuevo lead desde tu portal</h1>
        </td>
        <td style="padding:24px 32px 24px 0;vertical-align:middle;text-align:right;white-space:nowrap">
          <span style="font-size:1.5rem;font-weight:300;color:#fff">Inmob</span><span style="font-size:1.7rem;font-weight:400;color:#c9a84c">IA</span>
        </td>
      </tr></table>
    </div>

    <div style="padding:22px 32px 4px">
      <p style="margin:0 0 18px;font-size:0.92rem;color:#444">Hola <strong>${refNombre || ''}</strong>, tienes un nuevo cliente interesado desde tu portal InmobIA.</p>
    </div>

    <div style="padding:0 32px 18px">
      <h2 style="margin:0 0 6px;font-size:1.1rem;color:#1e2d4a">Propiedad de interés</h2>
      <p style="margin:0 0 4px;font-size:0.95rem;color:#1e2d4a">${titulo}</p>
      ${specsLinea ? `<p style="margin:0 0 6px;font-size:0.85rem;color:#666">${specsLinea}</p>` : ''}
      ${urlProp ? `<p style="margin:0"><a href="${urlProp}" style="color:#c9a84c;font-size:0.85rem;text-decoration:none">Ver propiedad →</a></p>` : ''}
    </div>

    <div style="margin:0 32px 20px;border:2px solid #1e2d4a;border-radius:10px;padding:18px 20px">
      <h2 style="margin:0 0 14px;font-size:1.05rem;color:#1e2d4a">Datos del cliente</h2>
      <div style="font-size:0.88rem;color:#444;line-height:1.5">${clienteFilas || '<em style="color:#888">Sin datos adicionales</em>'}</div>
    </div>

    <div style="margin:18px 32px 4px;padding:14px 16px;background:#fff7e3;border-left:3px solid #c9a84c;border-radius:6px;font-size:0.82rem;color:#1e2d4a;line-height:1.5">
      <p style="margin:0 0 8px;font-weight:600">🤝 Modelo tripartito InmobIA</p>
      <p style="margin:0 0 14px;color:#444">Este lead surgió de una propiedad compartida en la red InmobIA. Usted trae al cliente; el modelo tripartito aplica al cierre.</p>
      <p style="margin:0 0 4px;color:#444">Distribución de porcentajes de comisión al cierre:</p>
      <ul style="margin:6px 0 0;padding-left:18px;color:#444">
        <li><strong>40%</strong> asesor captor (dueño de la propiedad)</li>
        <li><strong>40%</strong> asesor referente (trae al cliente)</li>
        <li><strong>20%</strong> InmobIA</li>
      </ul>
    </div>

    <div style="margin:0 32px 8px;padding:14px 16px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:6px;font-size:0.82rem;color:#444;line-height:1.5">
      <p style="margin:0 0 6px;font-weight:600;color:#065f46">Siguiente paso</p>
      <p style="margin:0">Ingresa a tu CRM para revisar el lead y aceptar el convenio de colaboración. Los datos de contacto del asesor captor estarán disponibles una vez que ambos firmen el convenio.</p>
    </div>

    <div style="padding:18px 32px 28px;text-align:center">
      <a href="${BASE_URL}/panel-asesor.html#crm" style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;font-weight:600;font-size:0.88rem">Ver el lead en mi CRM →</a>
    </div>

    <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente al recibir un nuevo lead tripartito
    </div>
  </div>
</body></html>`;
}

function htmlNotificacion(nombreAsesor, tipoLabel, filas, bloqueExtra = '') {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:24px 32px;vertical-align:middle">
          <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;font-family:Arial,sans-serif;text-transform:uppercase;letter-spacing:0.08em">${tipoLabel}</p>
          <h1 style="margin:0;color:#fff;font-size:1.2rem;font-weight:600;font-family:Arial,sans-serif">Nuevo lead desde tu portal</h1>
        </td>
        <td style="padding:24px 32px 24px 0;vertical-align:middle;text-align:right;white-space:nowrap">
          <span style="font-family:Arial,sans-serif;font-size:1.5rem;font-weight:300;color:#fff">Inmob</span><span style="font-family:Arial,sans-serif;font-size:1.7rem;font-weight:400;color:#c9a84c">IA</span>
        </td>
      </tr></table>
    </div>
    <div style="padding:24px 32px 8px">
      <p style="margin:0 0 16px;font-size:0.9rem;color:#444">Hola <strong>${nombreAsesor}</strong>, tienes un nuevo cliente interesado desde tu portal InmobIA.</p>
      <table style="width:100%;border-collapse:collapse">${filas}</table>
    </div>
    ${bloqueExtra}
    <div style="padding:20px 32px 28px">
      <a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm"
         style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:11px 28px;border-radius:7px;font-weight:600;font-size:0.85rem">
        Ver en mi CRM →
      </a>
    </div>
    <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente al recibir un nuevo lead
    </div>
  </div>
</body></html>`;
}

function htmlNotificacion2A({ asesorNombre, clienteNombre, prop, propiedadTitulo, diaHora, dias, horario, mensaje, propiedadUrl }) {
  const titulo    = prop?.titulo || propiedadTitulo || 'Propiedad';
  const proyecto  = prop?.nombre_proyecto ? ` — ${prop.nombre_proyecto}` : '';
  const sym       = prop?.moneda === 'USD' ? '$' : 'Q';
  const precio    = prop?.precio ? `${sym}${Number(prop.precio).toLocaleString('es-GT')}` : '';
  const specs     = [
    prop?.habitaciones ? `${prop.habitaciones} hab.`   : '',
    prop?.banos        ? `${prop.banos} baños`         : '',
    prop?.parqueos     ? `${prop.parqueos} parq.`      : '',
    prop?.metros       ? `${prop.metros} m²`           : '',
  ].filter(Boolean).join(' · ');
  const operLabel = prop?.operacion === 'renta' ? 'Renta' : 'Venta';
  const zonaLine  = prop?.zona ? `<tr><td style="${tdL}">Zona</td><td style="${tdR}">${prop.zona}</td></tr>` : '';

  const citaLine = diaHora
    ? `<tr><td style="${tdL}">Día y hora solicitados</td><td style="${tdR}"><strong>${diaHora}</strong></td></tr>`
    : [
        dias    && `<tr><td style="${tdL}">Días disponibles</td><td style="${tdR}">${dias}</td></tr>`,
        horario && `<tr><td style="${tdL}">Horario preferido</td><td style="${tdR}">${horario}</td></tr>`,
      ].filter(Boolean).join('');

  const mensajeBloque = mensaje ? `
    <div style="margin:18px 32px 4px;padding:14px 16px;background:#f8f9fc;border-left:3px solid #c9a84c;border-radius:6px">
      <p style="margin:0 0 6px;font-size:0.78rem;font-weight:600;color:#1e2d4a">Mensaje del cliente</p>
      <p style="margin:0;font-size:0.85rem;color:#444;line-height:1.55">${mensaje}</p>
    </div>` : '';

  const avisoContacto = `
    <div style="margin:14px 32px 4px;padding:12px 16px;background:#fff7e3;border-left:3px solid #c9a84c;border-radius:6px;font-size:0.8rem;color:#1e2d4a;line-height:1.5">
      <strong>Modelo 2A — InmobIA</strong><br>
      Este cliente llegó a través de InmobIA. Toda la comunicación con él debe realizarse
      <strong>exclusivamente por el panel InmobIA</strong> — no por WhatsApp ni correo directo.
      Los datos de contacto del cliente no se comparten; usa el chat de la ficha del lead en tu CRM.
    </div>`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:24px 32px;vertical-align:middle">
          <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em">Modelo 2A · Solicitud de visita</p>
          <h1 style="margin:0;color:#fff;font-size:1.2rem;font-weight:600">Nuevo lead desde tu portal</h1>
        </td>
        <td style="padding:24px 32px 24px 0;vertical-align:middle;text-align:right;white-space:nowrap">
          <span style="font-size:1.5rem;font-weight:300;color:#fff">Inmob</span><span style="font-size:1.7rem;font-weight:400;color:#c9a84c">IA</span>
        </td>
      </tr></table>
    </div>

    <div style="padding:24px 32px 8px">
      <p style="margin:0 0 16px;font-size:0.9rem;color:#444">Hola <strong>${asesorNombre}</strong>, tienes un nuevo cliente interesado desde InmobIA.</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="${tdL}">Cliente</td><td style="${tdR}"><strong>${clienteNombre || '—'}</strong></td></tr>
        <tr><td style="${tdL}">Propiedad</td><td style="${tdR}"><strong>${titulo}${proyecto}</strong></td></tr>
        <tr><td style="${tdL}">Operación</td><td style="${tdR}">${operLabel}${precio ? ` · ${precio}` : ''}</td></tr>
        ${specs ? `<tr><td style="${tdL}">Características</td><td style="${tdR}">${specs}</td></tr>` : ''}
        ${zonaLine}
        ${citaLine}
      </table>
    </div>

    ${mensajeBloque}
    ${avisoContacto}

    <div style="padding:20px 32px 28px">
      <a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm"
         style="display:inline-block;background:#1e2d4a;color:#fff;text-decoration:none;padding:11px 28px;border-radius:7px;font-weight:600;font-size:0.85rem">
        Ver el lead en mi CRM →
      </a>
      ${propiedadUrl ? `<p style="margin:10px 0 0;font-size:0.75rem;color:#999"><a href="${propiedadUrl}" style="color:#c9a84c">Ver propiedad →</a></p>` : ''}
    </div>

    <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente al recibir un nuevo lead
    </div>
  </div>
</body></html>`;
}

function htmlConfirmacionCliente({ nombre, propTitulo, magicUrl, esRenta }) {
  const primerNombre = (nombre || 'Cliente').split(' ')[0];
  const bloquePago = esRenta ? `
    <div style="margin:0 0 24px;background:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #16a34a;border-radius:8px;padding:18px 20px">
      <p style="margin:0 0 10px;font-size:0.85rem;font-weight:700;color:#15803d">📋 Instrucciones de pago — Cliente InmobIA</p>
      <p style="margin:0 0 10px;font-size:0.82rem;color:#444;line-height:1.6">Al momento de firmar el contrato, recibirá las instrucciones de pago. El proceso es el siguiente:</p>
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
        <tr style="background:#dcfce7">
          <td style="padding:8px 12px;font-weight:600;color:#15803d;border-bottom:1px solid #bbf7d0">30% del depósito</td>
          <td style="padding:8px 12px;color:#444;border-bottom:1px solid #bbf7d0">Pago directo a <strong>InmobIA</strong> · link de pago o transferencia</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#1e2d4a;border-bottom:1px solid #e5e7eb">70% del depósito</td>
          <td style="padding:8px 12px;color:#444;border-bottom:1px solid #e5e7eb">Pago directo al <strong>propietario</strong></td>
        </tr>
        <tr style="background:#f8f9fc">
          <td style="padding:8px 12px;font-weight:600;color:#1e2d4a">100% primera renta</td>
          <td style="padding:8px 12px;color:#444">Pago directo al <strong>propietario</strong></td>
        </tr>
      </table>
      <p style="margin:12px 0 0;font-size:0.75rem;color:#64748b;line-height:1.5">⚠️ InmobIA le enviará el link de pago oficial en el momento indicado. <strong>No realice ningún pago sin recibir instrucciones oficiales de InmobIA.</strong></p>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c;padding:28px 32px">
      <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em">Tu solicitud fue recibida</p>
      <h1 style="margin:0;color:#fff;font-size:1.25rem;font-weight:600">¡Hola, ${primerNombre}!</h1>
    </div>
    <div style="padding:28px 32px">
      <p style="margin:0 0 16px;font-size:0.92rem;color:#444;line-height:1.6">
        Recibimos tu solicitud de visita para <strong>${propTitulo}</strong>.<br>
        El asesor te contactará a la brevedad por WhatsApp para confirmar la visita.
      </p>
      ${bloquePago}
      <p style="margin:0 0 24px;font-size:0.92rem;color:#444;line-height:1.6">
        Puedes revisar el estado de tu solicitud, ver propiedades sugeridas y comunicarte con el asesor desde tu panel personal:
      </p>
      <div style="text-align:center;margin-bottom:28px">
        <a href="${magicUrl}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:0.95rem;letter-spacing:0.02em">
          Ver mi panel de cliente →
        </a>
        <p style="margin:10px 0 0;font-size:0.72rem;color:#999">Este enlace es personal e intransferible — se renueva automáticamente con cada acceso</p>
      </div>
      <div style="background:#f8f9fc;border-radius:8px;padding:14px 18px;font-size:0.82rem;color:#64748b;line-height:1.55">
        ¿Tienes preguntas? Desde tu panel puedes enviarle un mensaje directamente al asesor.
      </div>
    </div>
    <div style="background:#f4f6fb;padding:14px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente. No respondas a este email.
    </div>
  </div>
</body></html>`;
}

export default router;
