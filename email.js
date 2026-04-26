import nodemailer from 'nodemailer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

// Transporter con Gmail SMTP
export function crearTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// HTML del correo principal (todos los datos)
export function htmlCorreoPrincipal(datos) {
  const { codigo, url_propiedad, ...resto } = datos;

  const filas = Object.entries(resto)
    .filter(([, v]) => v)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;white-space:nowrap">${etiqueta(k)}</td>
        <td style="padding:8px 12px;color:#444;border-bottom:1px solid #e5e2da">${v}</td>
      </tr>`).join('');

  const codigoRow = codigo ? `
      <tr>
        <td style="padding:8px 12px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;white-space:nowrap">Código de propiedad</td>
        <td style="padding:8px 12px;color:#444;border-bottom:1px solid #e5e2da;font-family:monospace;letter-spacing:0.08em">${codigo}</td>
      </tr>` : '';

  const btnPropiedad = url_propiedad ? `
    <div style="padding:0 32px 28px;text-align:center">
      <a href="${url_propiedad}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:12px 32px;border-radius:7px;font-weight:600;font-size:0.9rem;letter-spacing:0.05em">
        Propiedad de interés →
      </a>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600;font-family:Arial,sans-serif">Nueva solicitud de visita</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem;font-family:Arial,sans-serif">InmobIA — Panel de propiedades</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff;letter-spacing:0.01em">Inmob</span><span style="font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
        ${filas}
        ${codigoRow}
      </table>
    </div>
    ${btnPropiedad}
    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

// HTML del correo a suscriptores (campos seleccionados + mensaje personalizado)
export function htmlCorreoSuscriptor(datos, camposPermitidos, mensajePersonalizado) {
  const filas = Object.entries(datos)
    .filter(([k, v]) => camposPermitidos.includes(k) && v)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 12px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;white-space:nowrap">${etiqueta(k)}</td>
        <td style="padding:8px 12px;color:#444;border-bottom:1px solid #e5e2da">${v}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;padding:28px 32px;border-top:4px solid #c9a84c">
      <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">Solicitud de visita</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">InmobIA</p>
    </div>
    ${mensajePersonalizado ? `
    <div style="padding:20px 32px 0">
      <div style="background:#fdf8ee;border-left:4px solid #c9a84c;padding:14px 18px;border-radius:0 6px 6px 0;font-size:0.88rem;color:#555;line-height:1.6">
        ${mensajePersonalizado.replace(/\n/g, '<br>')}
      </div>
    </div>` : ''}
    <div style="padding:28px 32px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem">
        ${filas}
      </table>
    </div>
    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

// HTML del correo de bienvenida Premium
export function htmlCorreoBienvenidaPremium({ nombre, monto = 'Q399.00', moneda = 'GTQ', renovacionISO, checkoutId }) {
  const fmtFecha = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch { return iso; }
  };
  const fechaRenov = fmtFecha(renovacionISO);
  const hoy = fmtFecha(new Date().toISOString());

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600;font-family:Arial,sans-serif">¡Bienvenido a Premium!</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem;font-family:Arial,sans-serif">Confirmación de pago — InmobIA</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff;letter-spacing:0.01em">Inmob</span><span style="font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;color:#333;font-size:0.95rem">Hola <strong>${nombre || 'asesor'}</strong>,</p>
      <p style="margin:0 0 18px;color:#444;font-size:0.9rem;line-height:1.6">
        Su pago se recibió correctamente. Desde hoy su cuenta en InmobIA tiene todos los beneficios del plan <strong style="color:#c9a84c">Premium</strong>:
        leads ilimitados, propiedades destacadas, acceso a la red colaborativa y automatizaciones.
      </p>
    </div>

    <div style="padding:0 32px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem;border:1px solid #e5e2da;border-radius:6px;overflow:hidden">
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;width:40%">Plan</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">Premium InmobIA</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da">Monto cobrado</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da"><strong>${monto} ${moneda}</strong></td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da">Fecha de pago</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">${hoy}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da">Próxima renovación</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da"><strong>${fechaRenov}</strong></td>
        </tr>
        ${checkoutId ? `
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb">Referencia</td>
          <td style="padding:10px 14px;color:#444;font-family:monospace;letter-spacing:0.04em">${checkoutId}</td>
        </tr>` : ''}
      </table>
    </div>

    <div style="padding:0 32px 20px">
      <div style="background:#fdf8ee;border-left:4px solid #c9a84c;padding:14px 18px;border-radius:0 6px 6px 0;font-size:0.85rem;color:#5a4a1a;line-height:1.6">
        <strong>Sin permanencia.</strong> Puede cancelar desde su panel cuando lo desee; su plan seguirá activo hasta la fecha de renovación.
        La factura SAT se enviará por separado una vez emitida.
      </div>
    </div>

    <div style="padding:0 32px 28px;text-align:center">
      <a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:12px 28px;border-radius:7px;font-weight:600;font-size:0.9rem;letter-spacing:0.05em">
        Ir a mi panel →
      </a>
    </div>

    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

// Helper: envía correo de bienvenida Premium (no-throw — loggea errores sin romper flujo)
export async function enviarCorreoBienvenidaPremium({ email, nombre, monto, moneda, renovacionISO, checkoutId }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: '¡Bienvenido a Premium InmobIA! — Pago confirmado',
      html: htmlCorreoBienvenidaPremium({ nombre, monto, moneda, renovacionISO, checkoutId }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo Premium a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Correo: verificación de cierre al cliente ──
export function htmlCorreoVerificacionCierre({ nombreCliente, nombreAsesor, propiedadTitulo, valorCierre, moneda = 'GTQ', linkPanel, tipoOperacion, tipoPropiedad }) {
  const fmtMonto = (v) => {
    if (!v) return '—';
    const simbolo = moneda === 'USD' ? '$' : 'Q';
    return `${simbolo}${Number(v).toLocaleString('es-GT')}`;
  };
  const esRenta = String(tipoOperacion || '').toLowerCase() === 'renta';
  const TIPOS_HOGAR = ['casa', 'apartamento', 'penthouse', 'townhouse'];
  const esHogar = TIPOS_HOGAR.includes(String(tipoPropiedad || '').toLowerCase());
  const sustantivo = esHogar ? 'hogar' : 'propiedad';
  const articulo = esHogar ? 'nuevo' : 'nueva';
  const tituloHero = `¡Felicitaciones por tu ${articulo} ${sustantivo}!`;
  const accionPasado = esRenta ? 'rentaste' : 'compraste';
  const etiquetaValor = esRenta ? 'Valor de la renta' : 'Valor de la compra';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">${tituloHero}</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">InmobIA — Verificación de tu operación</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff">Inmob</span><span style="font-family:'Century Gothic',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;color:#333;font-size:0.95rem">Hola <strong>${nombreCliente || 'cliente'}</strong>,</p>
      <p style="margin:0 0 14px;color:#444;font-size:0.9rem;line-height:1.6">
        ¡Qué alegría saber que encontraste la propiedad que buscabas! En InmobIA nos emociona haber sido parte de este paso tan importante.
      </p>
      <p style="margin:0 0 18px;color:#444;font-size:0.9rem;line-height:1.6">
        <strong>${nombreAsesor || 'Tu asesor'}</strong> registró que ${accionPasado} esta propiedad a través de InmobIA.
        Para dar una calificación y seguimiento al servicio del asesor, agradecemos que lo confirmes desde tu panel para activar el registro del cierre.
      </p>
    </div>

    <div style="padding:0 32px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem;border:1px solid #e5e2da;border-radius:6px;overflow:hidden">
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;width:40%">Propiedad</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">${propiedadTitulo || '—'}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da">Asesor</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">${nombreAsesor || '—'}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb">${etiquetaValor}</td>
          <td style="padding:10px 14px;color:#444"><strong>${fmtMonto(valorCierre)} ${moneda}</strong></td>
        </tr>
      </table>
    </div>

    <div style="padding:0 32px 20px">
      <div style="background:#fdf8ee;border-left:4px solid #c9a84c;padding:14px 18px;border-radius:0 6px 6px 0;font-size:0.85rem;color:#5a4a1a;line-height:1.6">
        <strong>¿Por qué confirmas tú?</strong> Es nuestra forma de garantizar que cada cierre sea real.
        Solo tú puedes validar que la operación ocurrió, protegiéndote a ti y al asesor.
      </div>
    </div>

    <div style="padding:0 32px 28px;text-align:center">
      <a href="${linkPanel}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:7px;font-weight:600;font-size:0.95rem;letter-spacing:0.03em">
        Ir a mi panel para confirmar →
      </a>
    </div>

    <div style="padding:0 32px 28px;font-size:0.8rem;color:#666;line-height:1.6;text-align:center">
      Si este cierre <strong>no</strong> ocurrió o hay algún error, también puedes reportarlo desde el mismo panel.
    </div>

    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoVerificacionCierre({ email, nombreCliente, nombreAsesor, propiedadTitulo, valorCierre, moneda, linkPanel, tipoOperacion, tipoPropiedad }) {
  if (!email) return { ok: false, error: 'sin email' };
  const esRenta = String(tipoOperacion || '').toLowerCase() === 'renta';
  const TIPOS_HOGAR = ['casa', 'apartamento', 'penthouse', 'townhouse'];
  const esHogar = TIPOS_HOGAR.includes(String(tipoPropiedad || '').toLowerCase());
  const sustantivo = esHogar ? 'hogar' : 'propiedad';
  const articulo = esHogar ? 'nuevo' : 'nueva';
  const accion = esRenta ? 'tu renta' : 'tu compra';
  const asunto = `¡Felicitaciones por tu ${articulo} ${sustantivo}! — Confirma ${accion}`;
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: asunto,
      html: htmlCorreoVerificacionCierre({ nombreCliente, nombreAsesor, propiedadTitulo, valorCierre, moneda, linkPanel, tipoOperacion, tipoPropiedad }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo verificación cierre a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Correo: cobro de comisión al asesor (tras cliente confirmar cierre) ──
export function htmlCorreoComisionAsesor({ nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionInmobia, moneda = 'GTQ', linkPago, diasPlazo = 5 }) {
  const fmtMonto = (v) => {
    if (!v) return '—';
    const simbolo = moneda === 'USD' ? '$' : 'Q';
    return `${simbolo}${Number(v).toLocaleString('es-GT')}`;
  };
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">Cierre confirmado</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">Cobro de comisión — InmobIA</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff">Inmob</span><span style="font-family:'Century Gothic',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;color:#333;font-size:0.95rem">Hola <strong>${nombreAsesor || 'asesor'}</strong>,</p>
      <p style="margin:0 0 18px;color:#444;font-size:0.9rem;line-height:1.6">
        ¡Felicitaciones! <strong>${nombreCliente || 'El cliente'}</strong> confirmó el cierre de la propiedad.
        Genera tu pago de comisión InmobIA desde el link de abajo.
      </p>
    </div>

    <div style="padding:0 32px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:0.88rem;border:1px solid #e5e2da;border-radius:6px;overflow:hidden">
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da;width:45%">Propiedad</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">${propiedadTitulo || '—'}</td>
        </tr>
        <tr>
          <td style="padding:10px 14px;font-weight:600;color:#1e2d4a;background:#f4f6fb;border-bottom:1px solid #e5e2da">Valor del cierre</td>
          <td style="padding:10px 14px;color:#444;border-bottom:1px solid #e5e2da">${fmtMonto(valorCierre)} ${moneda}</td>
        </tr>
        <tr>
          <td style="padding:12px 14px;font-weight:700;color:#1e2d4a;background:#fdf8ee">Comisión a pagar a InmobIA</td>
          <td style="padding:12px 14px;color:#8a6d1f;background:#fdf8ee;font-weight:700;font-size:1.05rem">${fmtMonto(comisionInmobia)} ${moneda}</td>
        </tr>
      </table>
    </div>

    <div style="padding:0 32px 28px;text-align:center">
      <a href="${linkPago}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:7px;font-weight:700;font-size:0.98rem;letter-spacing:0.03em">
        Pagar comisión ahora →
      </a>
      <p style="margin:14px 0 0;font-size:0.75rem;color:#999">Tarjeta o transferencia · Acreditación en 24h</p>
    </div>

    <div style="padding:0 32px 20px">
      <div style="background:#fdf8ee;border-left:4px solid #c9a84c;padding:14px 18px;border-radius:0 6px 6px 0;font-size:0.82rem;color:#5a4a1a;line-height:1.6">
        <strong>Plazo de pago:</strong> ${diasPlazo} días hábiles.
        La factura SAT se emitirá al confirmar el pago. Tu link también estará disponible en tu panel.
      </div>
    </div>

    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoComisionAsesor({ email, nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionInmobia, moneda, linkPago, diasPlazo }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Cierre confirmado — cobro de comisión InmobIA`,
      html: htmlCorreoComisionAsesor({ nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionInmobia, moneda, linkPago, diasPlazo }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo comisión a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Modelo 1D — InmobIA paga al asesor por transferencia ──
// Email enviado al asesor cuando el cliente confirma el cierre.
// InmobIA es dueña de la propiedad → recibe el pago del cliente → debe pagar al asesor.
export function htmlCorreoCierreConfirmado1D({ nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionAsesor, moneda = 'GTQ' }) {
  const simbolo = moneda === 'USD' ? '$' : 'Q';
  const fmt = (n) => `${simbolo}${Number(n || 0).toLocaleString('es-GT')}`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    <div style="background:linear-gradient(135deg,#1a5e3f 0%,#2e7d32 100%);padding:2rem 1.5rem;text-align:center">
      <div style="color:#fff;font-size:1.6rem;font-weight:700;margin-bottom:0.3rem">¡Felicitaciones, ${nombreAsesor || 'asesor'}!</div>
      <div style="color:#d4edda;font-size:0.95rem">Tu cliente confirmó el cierre</div>
    </div>

    <div style="padding:2rem 1.5rem;color:#333;line-height:1.55">
      <p style="margin:0 0 1rem 0;font-size:1rem">
        ${nombreCliente || 'El cliente'} acaba de confirmar el cierre de <strong>${propiedadTitulo || 'la propiedad'}</strong>.
        Esta propiedad es parte del programa <strong>InmobIA Directo (Modelo 1D)</strong>, donde InmobIA gestiona la propiedad directamente con el propietario.
      </p>

      <div style="background:#e8f5e9;border-left:3px solid #2e7d32;border-radius:6px;padding:1rem 1.2rem;margin:1.2rem 0">
        <div style="font-size:0.78rem;color:#1b5e20;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:0.4rem">Tu comisión por este cierre</div>
        <div style="font-size:1.6rem;font-weight:800;color:#1b5e20">${fmt(comisionAsesor)}</div>
        <div style="font-size:0.8rem;color:#2e7d32;margin-top:0.3rem">Valor del cierre: ${fmt(valorCierre)}</div>
      </div>

      <div style="background:#fffaf0;border:1px solid #f3e0a8;border-radius:6px;padding:1rem 1.2rem;margin:1.2rem 0">
        <div style="font-size:0.85rem;color:#7a5a1a;font-weight:600;margin-bottom:0.4rem">📌 ¿Cómo recibirás tu pago?</div>
        <p style="margin:0;font-size:0.85rem;color:#5a4a1a;line-height:1.55">
          InmobIA recibirá primero el pago del propietario por la operación. Una vez confirmada la fecha de pago con el propietario,
          te transferiremos tu comisión por <strong>transferencia bancaria</strong> y te enviaremos un correo con la fecha exacta y los detalles del depósito.
        </p>
      </div>

      <p style="margin:1rem 0 0 0;font-size:0.9rem;color:#555">
        Asegúrate de que tus datos bancarios estén actualizados en tu panel.
        Si tienes dudas sobre este cierre, escríbenos a <a href="mailto:hola@inmobia.gt" style="color:#1a5e3f">hola@inmobia.gt</a>.
      </p>

      <p style="margin:1.5rem 0 0 0;font-size:0.95rem">
        ¡Gracias por confiar en InmobIA!
      </p>
    </div>

    <div style="background:#fafafa;padding:1rem 1.5rem;text-align:center;color:#999;font-size:0.7rem;border-top:1px solid #eee">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoCierreConfirmado1D({ email, nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionAsesor, moneda }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `¡Cierre confirmado! Tu comisión está en proceso`,
      html: htmlCorreoCierreConfirmado1D({ nombreAsesor, nombreCliente, propiedadTitulo, valorCierre, comisionAsesor, moneda }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo cierre 1D a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Modelo 1D — Notificación de fecha de pago programada ──
// Enviado al asesor cuando el admin de InmobIA registra la fecha confirmada con el propietario.
export function htmlCorreoPagoProgramado1D({ nombreAsesor, propiedadTitulo, comisionAsesor, moneda = 'GTQ', fechaPago, referencia, notas }) {
  const simbolo = moneda === 'USD' ? '$' : 'Q';
  const fmt = (n) => `${simbolo}${Number(n || 0).toLocaleString('es-GT')}`;
  const fechaLegible = fechaPago
    ? new Date(fechaPago + 'T00:00:00').toLocaleDateString('es-GT', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    <div style="background:linear-gradient(135deg,#1a5e3f 0%,#2e7d32 100%);padding:2rem 1.5rem;text-align:center">
      <div style="color:#fff;font-size:1.5rem;font-weight:700;margin-bottom:0.3rem">Tu pago está programado</div>
      <div style="color:#d4edda;font-size:0.9rem">${propiedadTitulo || 'Cierre InmobIA'}</div>
    </div>

    <div style="padding:2rem 1.5rem;color:#333;line-height:1.55">
      <p style="margin:0 0 1rem 0">Hola ${nombreAsesor || 'asesor'},</p>
      <p style="margin:0 0 1rem 0">
        Confirmamos con el propietario la fecha de pago de la operación. A continuación los detalles del depósito de tu comisión:
      </p>

      <div style="background:#e8f5e9;border-left:3px solid #2e7d32;border-radius:6px;padding:1.1rem 1.3rem;margin:1.2rem 0">
        <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">
          <span style="font-size:0.78rem;color:#1b5e20;text-transform:uppercase;letter-spacing:0.5px;font-weight:700">Monto a recibir</span>
          <span style="font-size:1.1rem;font-weight:800;color:#1b5e20">${fmt(comisionAsesor)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">
          <span style="font-size:0.78rem;color:#1b5e20;text-transform:uppercase;letter-spacing:0.5px;font-weight:700">Fecha de transferencia</span>
          <span style="font-size:0.95rem;font-weight:700;color:#1b5e20">${fechaLegible || '—'}</span>
        </div>
        ${referencia ? `<div style="display:flex;justify-content:space-between">
          <span style="font-size:0.78rem;color:#1b5e20;text-transform:uppercase;letter-spacing:0.5px;font-weight:700">Referencia</span>
          <span style="font-size:0.85rem;color:#1b5e20">${referencia}</span>
        </div>` : ''}
      </div>

      ${notas ? `<div style="background:#fffaf0;border:1px solid #f3e0a8;border-radius:6px;padding:0.9rem 1.2rem;margin:1rem 0;font-size:0.85rem;color:#5a4a1a">
        <strong>Notas:</strong> ${notas}
      </div>` : ''}

      <p style="margin:1.2rem 0 0 0;font-size:0.85rem;color:#555">
        Si no recibes el depósito en la fecha indicada, escríbenos a <a href="mailto:hola@inmobia.gt" style="color:#1a5e3f">hola@inmobia.gt</a>.
      </p>
    </div>

    <div style="background:#fafafa;padding:1rem 1.5rem;text-align:center;color:#999;font-size:0.7rem;border-top:1px solid #eee">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoPagoProgramado1D({ email, nombreAsesor, propiedadTitulo, comisionAsesor, moneda, fechaPago, referencia, notas }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Tu pago está programado — InmobIA`,
      html: htmlCorreoPagoProgramado1D({ nombreAsesor, propiedadTitulo, comisionAsesor, moneda, fechaPago, referencia, notas }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo pago programado a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

export async function enviarCorreoVisitaConfirmada5RA({ email, nombreCliente, nombreCaptor, nombreReferente, propiedadTitulo, fechaVisita, linkPanel }) {
  if (!email) return { ok: false, error: 'sin email' };
  const fechaFmt = fechaVisita ? new Date(fechaVisita).toLocaleDateString('es-GT', { weekday:'long', day:'numeric', month:'long', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true }) : fechaVisita;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f4f6fb;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;padding:28px 32px;border-top:4px solid #c9a84c">
      <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">Tu visita está confirmada</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">InmobIA — Red de Asesores</p>
    </div>
    <div style="padding:28px 32px">
      <p style="color:#444;line-height:1.6">Hola <strong>${nombreCliente || 'Cliente'}</strong>,</p>
      <p style="color:#444;line-height:1.6">Tu visita a <strong>${propiedadTitulo || 'la propiedad'}</strong> ha sido coordinada y confirmada por ambos asesores.</p>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #c9a84c;border-radius:8px;padding:16px 20px;margin:20px 0">
        <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#92733a;margin-bottom:6px">Fecha y hora de la visita</div>
        <div style="font-size:1.1rem;font-weight:700;color:#1e2d4a;text-transform:capitalize">${fechaFmt || '—'}</div>
      </div>
      <p style="color:#444;line-height:1.6">Tus asesores: <strong>${nombreCaptor || '—'}</strong> y <strong>${nombreReferente || '—'}</strong> estarán coordinando los detalles contigo.</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${linkPanel}" style="background:#c9a84c;color:#1e2d4a;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:8px;font-size:1rem;display:inline-block">Ver mi visita y confirmar asistencia →</a>
      </div>
      <p style="color:#888;font-size:0.82rem">Este enlace te da acceso a tu panel personal. Válido por 30 días.</p>
    </div>
    <div style="background:#f4f6fb;padding:16px 32px;text-align:center">
      <p style="margin:0;color:#aaa;font-size:0.78rem">InmobIA · Guatemala · <a href="https://inmobia.com" style="color:#c9a84c;text-decoration:none">inmobia.com</a></p>
    </div>
  </div>
</body></html>`;
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Tu visita está confirmada — ${propiedadTitulo || 'InmobIA'}`,
      html,
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo visita 5RA a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Correo: solicitud de calificación al cliente ──
export function htmlCorreoSolicitarCalificacion({ nombreCliente, nombreAsesor, propiedadTitulo, linkCalificar }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">¿Cómo te fue en tu visita?</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">InmobIA — Tu opinión importa</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff;letter-spacing:0.01em">Inmob</span><span style="font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;color:#333;font-size:0.95rem">Hola <strong>${nombreCliente || 'cliente'}</strong>,</p>
      <p style="margin:0 0 14px;color:#444;font-size:0.9rem;line-height:1.6">
        Gracias por visitar la propiedad <strong>${propiedadTitulo || ''}</strong> con el asesor <strong>${nombreAsesor || ''}</strong>.
      </p>
      <p style="margin:0 0 18px;color:#444;font-size:0.9rem;line-height:1.6">
        Tu opinión nos ayuda a mantener la calidad del servicio y a que otros clientes tomen mejores decisiones. Solo toma 30 segundos.
      </p>
    </div>

    <!-- Estrellas decorativas -->
    <div style="padding:0 32px 20px;text-align:center">
      <div style="font-size:2rem;letter-spacing:0.15em;color:#c9a84c">★ ★ ★ ★ ★</div>
      <div style="font-size:0.8rem;color:#94a3b8;margin-top:0.3rem">Califica tu experiencia</div>
    </div>

    <div style="padding:0 32px 28px;text-align:center">
      <a href="${linkCalificar}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:1rem;letter-spacing:0.02em">
        Dejar mi calificación →
      </a>
      <p style="margin:12px 0 0;font-size:0.75rem;color:#94a3b8">Tarda menos de 30 segundos · Sin registro requerido</p>
    </div>

    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoSolicitarCalificacion({ email, nombreCliente, nombreAsesor, propiedadTitulo, linkCalificar }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `¿Cómo te fue? Califica tu visita con ${nombreAsesor || 'el asesor'}`,
      html: htmlCorreoSolicitarCalificacion({ nombreCliente, nombreAsesor, propiedadTitulo, linkCalificar }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo calificación a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Correo: recuperación de contraseña ──
export function htmlCorreoResetPassword({ nombre, linkReset }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#1e2d4a;border-top:4px solid #c9a84c">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:28px 32px;vertical-align:middle">
            <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:600">Recupera tu contraseña</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:0.85rem">InmobIA — Acceso seguro</p>
          </td>
          <td style="padding:28px 32px 28px 0;vertical-align:middle;text-align:right;white-space:nowrap">
            <span style="font-family:'Comfortaa',Arial,sans-serif;font-size:1.7rem;font-weight:300;color:#ffffff;letter-spacing:0.01em">Inmob</span><span style="font-family:'Century Gothic','Trebuchet MS',Arial,sans-serif;font-size:1.9rem;font-weight:400;color:#c9a84c">IA</span>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;color:#333;font-size:0.95rem">Hola <strong>${nombre || 'asesor'}</strong>,</p>
      <p style="margin:0 0 14px;color:#444;font-size:0.9rem;line-height:1.6">
        Recibimos una solicitud para restablecer la contraseña de tu cuenta en InmobIA.
        Usa el botón de abajo para crear una nueva contraseña.
      </p>
      <p style="margin:0 0 18px;color:#94a3b8;font-size:0.82rem;line-height:1.5">
        Si no solicitaste este cambio, ignora este correo. Tu contraseña actual seguirá siendo la misma.
      </p>
    </div>

    <div style="padding:0 32px 28px;text-align:center">
      <a href="${linkReset}" style="display:inline-block;background:#c9a84c;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:1rem;letter-spacing:0.02em">
        Crear nueva contraseña →
      </a>
      <p style="margin:12px 0 0;font-size:0.75rem;color:#94a3b8">Este enlace expira en 1 hora · Un solo uso</p>
    </div>

    <div style="padding:0 32px 20px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;font-size:0.78rem;color:#64748b;line-height:1.5;word-break:break-all">
        Si el botón no funciona, copia este enlace en tu navegador:<br>
        <span style="color:#3b82f6">${linkReset}</span>
      </div>
    </div>

    <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:0.75rem;color:#999;border-top:1px solid #e5e2da">
      InmobIA · Este correo fue generado automáticamente
    </div>
  </div>
</body>
</html>`;
}

export async function enviarCorreoResetPassword({ email, nombre, linkReset }) {
  if (!email) return { ok: false, error: 'sin email' };
  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Recupera tu contraseña — InmobIA',
      html: htmlCorreoResetPassword({ nombre, linkReset }),
    });
    return { ok: true };
  } catch (err) {
    console.error('⚠️  Error enviando correo reset a', email, '→', err.message);
    return { ok: false, error: err.message };
  }
}

// Mapeo de claves a etiquetas legibles
function etiqueta(clave) {
  const mapa = {
    nombre:           'Nombre',
    telefono:         'WhatsApp',
    email:            'Correo electrónico',
    tipo_propiedad:   'Tipo de propiedad',
    propiedad:        'Propiedad',
    proyecto:         'Proyecto / Residencial',
    zona:             'Zona',
    dias:             'Días disponibles',
    horario:          'Rango horario',
    dia_hora:         'Día y hora preferidos',
    comentario:       'Comentario adicional',
  };
  return mapa[clave] || clave;
}
