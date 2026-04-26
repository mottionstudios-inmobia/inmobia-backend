import { db } from './database.js';
import { crearTransporter } from './email.js';

// Tiempos en milisegundos
const NOTIF_24H = 24 * 60 * 60 * 1000;
const NOTIF_72H = 72 * 60 * 60 * 1000;
const NOTIF_120H = 120 * 60 * 60 * 1000;
const ALERTA_144H = 144 * 60 * 60 * 1000;

async function enviarNotificacionAgendamiento(lead, tipoNotif) {
  try {
    const transporter = crearTransporter();

    // Buscar a los asesores involucrados
    const captor = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_id);
    const referente = lead.asesor_referente_id
      ? db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_referente_id)
      : null;

    const emails = [captor?.email, referente?.email].filter(Boolean);
    if (emails.length === 0) return;

    let asunto, mensajeHTML;

    if (tipoNotif === '24h') {
      asunto = '⏰ Agendar visita: falta 1 paso para avanzar';
      mensajeHTML = `
        <p style="margin:0 0 14px;color:#444">Hola,</p>
        <p style="margin:0 0 14px;color:#444">Han pasado <strong>24 horas</strong> desde que se aceptó el convenio para el lead de <strong>${lead.nombre}</strong>. Es momento de agendar la visita para avanzar al siguiente paso.</p>
        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:0.85rem">
          <strong>📍 Próximo paso:</strong> Coordinen con el cliente y registren la fecha y hora de la visita en el CRM.
        </div>`;
    } else if (tipoNotif === '72h') {
      asunto = '⚠️ Pendiente: agendar visita (72 horas)';
      mensajeHTML = `
        <p style="margin:0 0 14px;color:#444">Hola,</p>
        <p style="margin:0 0 14px;color:#444"><strong>Han pasado 72 horas</strong> y aún no se ha agendado la visita para el lead de <strong>${lead.nombre}</strong>. Por favor, coordinen y registren la fecha y hora cuanto antes.</p>
        <div style="background:#ffe5e5;border:1px solid #ff6b6b;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:0.85rem">
          <strong>⚡ Urgente:</strong> Ingresen la fecha y hora de la visita para no perder el momentum con el cliente.
        </div>`;
    } else if (tipoNotif === '120h') {
      asunto = '🚨 Último aviso: agendar visita (120 horas)';
      mensajeHTML = `
        <p style="margin:0 0 14px;color:#444">Hola,</p>
        <p style="margin:0 0 14px;color:#444"><strong>ÚLTIMO AVISO:</strong> Han pasado <strong>120 horas (5 días)</strong> desde la aceptación del convenio y la visita aún no está agendada para el lead de <strong>${lead.nombre}</strong>.</p>
        <div style="background:#fee;border:1px solid #f88;border-radius:8px;padding:12px 14px;margin:14px 0;font-size:0.85rem;color:#d00">
          <strong>⛔ Crítico:</strong> Si no agendan la visita en las próximas 24 horas, InmobIA se pondrá en contacto para verificar el estatus del cliente y los asesores.
        </div>`;
    }

    for (const email of emails) {
      await transporter.sendMail({
        from: `"InmobIA" <${process.env.SMTP_USER}>`,
        to: email,
        subject: asunto,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
          <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:#1e2d4a;border-top:4px solid #f59e0b;padding:22px 32px">
              <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">📅 Seguimiento de visita</p>
              <h1 style="margin:0;color:#fff;font-size:1.15rem">${asunto}</h1>
            </div>
            <div style="padding:24px 32px">
              ${mensajeHTML}
              <div style="text-align:center;margin:22px 0 6px">
                <a href="${process.env.BASE_URL || 'http://localhost:5173'}/panel-asesor.html#crm" style="display:inline-block;background:#f59e0b;color:#1e2d4a;text-decoration:none;padding:11px 24px;border-radius:7px;font-weight:700;font-size:0.9rem">Agendar visita ahora →</a>
              </div>
            </div>
            <div style="background:#f4f6fb;padding:12px 32px;text-align:center;font-size:0.72rem;color:#999;border-top:1px solid #e5e2da">InmobIA · Recordatorio de agendamiento</div>
          </div>
        </body></html>`,
      });
    }
  } catch (err) {
    console.error(`Error enviando notificación ${tipoNotif} para lead ${lead.id}:`, err.message);
  }
}

async function enviarAlertaInmobia(lead) {
  try {
    const transporter = crearTransporter();
    const captor = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_id);
    const referente = lead.asesor_referente_id
      ? db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_referente_id)
      : null;

    const adminEmail = process.env.ADMIN_EMAIL || 'inmobia@inmobia.com';

    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: adminEmail,
      subject: `🚨 Alerta: verificar estatus de agendamiento - Lead ${lead.id}`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
        <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:#dc2626;border-top:4px solid #991b1b;padding:22px 32px;color:#fff">
            <p style="margin:0 0 4px;color:rgba(255,255,255,0.8);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">⚠️ Alerta automática</p>
            <h1 style="margin:0;font-size:1.15rem">Verificar estatus de agendamiento</h1>
          </div>
          <div style="padding:24px 32px;color:#444">
            <p style="margin:0 0 14px"><strong>Lead ID:</strong> ${lead.id}</p>
            <p style="margin:0 0 14px"><strong>Cliente:</strong> ${lead.nombre}</p>
            <p style="margin:0 0 14px"><strong>Captor (publicó lead):</strong> ${captor?.nombre}</p>
            ${referente ? `<p style="margin:0 0 14px"><strong>Referente (publicó requerimiento):</strong> ${referente.nombre}</p>` : ''}
            <p style="margin:0 0 14px"><strong>Convenio aceptado el:</strong> ${new Date(lead.convenio_aceptado_en).toLocaleString('es-GT')}</p>
            <p style="margin:0 0 14px"><strong>Tiempo transcurrido:</strong> 144 horas (6 días)</p>
            <p style="margin:0 0 14px"><strong>Nota de agendamiento:</strong> ${lead.agendamiento_nota || '(sin nota)'}</p>
            <hr style="border:none;border-top:1px solid #e5e2da;margin:16px 0">
            <p style="margin:0;font-size:0.85rem;color:#666"><strong>Acción requerida:</strong> Contactar a los asesores para verificar si la visita está agendada, si el cliente cambió de parecer, o si hay algún obstáculo en el proceso.</p>
          </div>
        </div>
      </body></html>`,
    });
  } catch (err) {
    console.error(`Error enviando alerta a InmobIA para lead ${lead.id}:`, err.message);
  }
}

export async function procesarNotificacionesAgendamiento() {
  try {
    const leads = db.prepare(`
      SELECT * FROM leads
      WHERE convenio_aceptado_en IS NOT NULL
      AND fecha_visita IS NULL
      AND origen = 'red-5ra'
    `).all();

    const ahora = Date.now();

    for (const lead of leads) {
      const tiempoAceptado = new Date(lead.convenio_aceptado_en).getTime();
      const tiempoTranscurrido = ahora - tiempoAceptado;

      // Notificación 24h
      if (tiempoTranscurrido >= NOTIF_24H && !lead.notif_agendamiento_24h_en) {
        console.log(`[24h] Enviando notificación para lead ${lead.id}`);
        await enviarNotificacionAgendamiento(lead, '24h');
        db.prepare('UPDATE leads SET notif_agendamiento_24h_en = ? WHERE id = ?')
          .run(new Date().toISOString(), lead.id);
      }

      // Notificación 72h
      if (tiempoTranscurrido >= NOTIF_72H && !lead.notif_agendamiento_72h_en) {
        console.log(`[72h] Enviando notificación para lead ${lead.id}`);
        await enviarNotificacionAgendamiento(lead, '72h');
        db.prepare('UPDATE leads SET notif_agendamiento_72h_en = ? WHERE id = ?')
          .run(new Date().toISOString(), lead.id);
      }

      // Notificación 120h
      if (tiempoTranscurrido >= NOTIF_120H && !lead.notif_agendamiento_120h_en) {
        console.log(`[120h] Enviando notificación para lead ${lead.id}`);
        await enviarNotificacionAgendamiento(lead, '120h');
        db.prepare('UPDATE leads SET notif_agendamiento_120h_en = ? WHERE id = ?')
          .run(new Date().toISOString(), lead.id);
      }

      // Alerta 144h (24h después del último aviso)
      if (tiempoTranscurrido >= ALERTA_144H && !lead.alerta_inmobia_144h_en) {
        console.log(`[144h] Enviando alerta a InmobIA para lead ${lead.id}`);
        await enviarAlertaInmobia(lead);
        db.prepare('UPDATE leads SET alerta_inmobia_144h_en = ? WHERE id = ?')
          .run(new Date().toISOString(), lead.id);
      }
    }
  } catch (err) {
    console.error('Error en procesarNotificacionesAgendamiento:', err.message);
  }
}

// ── RECORDATORIOS DE FECHAS DE PAGO (post-contrato 5RA) ───────────────────
// Timing: contrato_fecha+hora +24h → rec1 | +72h → rec2 | +96h → rec3
// Se desactivan cuando el captor ingresa deposito_fecha o comision_pago_fecha

const PAGO_REC1 = 24 * 60 * 60 * 1000;   // 24h desde contrato
const PAGO_REC2 = 72 * 60 * 60 * 1000;   // +48h desde rec1
const PAGO_REC3 = 96 * 60 * 60 * 1000;   // +24h desde rec2

async function enviarRecordatorioPago(lead, num) {
  try {
    const transporter = crearTransporter();
    const captor = db.prepare('SELECT nombre, email FROM usuarios WHERE id = ?').get(lead.asesor_id);
    if (!captor?.email) return;

    const urgencias = {
      1: { icon: '📅', titulo: '1er recordatorio: ingrese las fechas de pago', bg: '#fff3cd', border: '#ffc107', color: '#856404' },
      2: { icon: '⚠️', titulo: '2do recordatorio: fechas de pago pendientes', bg: '#ffe5e5', border: '#ff6b6b', color: '#d00' },
      3: { icon: '🚨', titulo: 'ÚLTIMO AVISO: fechas de pago requeridas urgente', bg: '#fee', border: '#f88', color: '#c00' },
    };
    const u = urgencias[num];
    const contratoFmt = `${lead.contrato_fecha}${lead.contrato_hora ? ' a las ' + lead.contrato_hora : ''}`;

    await transporter.sendMail({
      from: `"InmobIA" <${process.env.SMTP_USER}>`,
      to: captor.email,
      subject: `${u.icon} ${u.titulo} — ${lead.nombre}`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ede8;font-family:Arial,sans-serif">
        <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:#1e2d4a;border-top:4px solid #f59e0b;padding:22px 32px">
            <p style="margin:0 0 4px;color:rgba(255,255,255,0.6);font-size:0.78rem;text-transform:uppercase;letter-spacing:0.08em">Recordatorio #${num} — Fechas de pago</p>
            <h1 style="margin:0;color:#fff;font-size:1.15rem">${u.icon} ${u.titulo}</h1>
          </div>
          <div style="padding:28px 32px">
            <p style="margin:0 0 14px;color:#444">Hola <strong>${captor.nombre}</strong>,</p>
            <p style="margin:0 0 14px;color:#444">El contrato del cliente <strong>${lead.nombre}</strong> fue firmado el <strong>${contratoFmt}</strong>. Aún no ha ingresado las fechas de pago (depósito, primera renta / comisión).</p>
            <div style="background:${u.bg};border:1px solid ${u.border};border-radius:8px;padding:12px 14px;margin:14px 0;font-size:0.85rem;color:${u.color}">
              <strong>Acción requerida:</strong> Ingrese las fechas de pago en el paso "Comprometer fechas de pago" dentro del lead de <strong>${lead.nombre}</strong> en su CRM.
            </div>
            ${num === 3 ? `<p style="margin:14px 0 0;font-size:0.85rem;color:#c00"><strong>Este es el último recordatorio automático.</strong> Si no ingresa las fechas en las próximas horas, InmobIA se pondrá en contacto directamente para verificar el estado del negocio.</p>` : ''}
          </div>
        </div>
      </body></html>`,
    });
    console.log(`[pago-rec${num}] Recordatorio enviado a ${captor.email} para lead ${lead.id}`);
  } catch (err) {
    console.error(`Error enviando recordatorio de pago #${num} para lead ${lead.id}:`, err.message);
  }
}

async function procesarRecordatoriosPago() {
  try {
    const leads = db.prepare(`
      SELECT * FROM leads
      WHERE origen = 'red-5ra'
      AND contrato_fecha IS NOT NULL
      AND etapa NOT IN ('cerrado','inactivo')
      AND (deposito_fecha IS NULL AND comision_pago_fecha IS NULL)
    `).all();

    const ahora = Date.now();

    for (const lead of leads) {
      const contratoISO = lead.contrato_hora
        ? `${lead.contrato_fecha}T${lead.contrato_hora}:00`
        : `${lead.contrato_fecha}T00:00:00`;
      const contrato = new Date(contratoISO).getTime();
      if (isNaN(contrato)) continue;
      const elapsed = ahora - contrato;

      if (elapsed >= PAGO_REC1 && !lead.notif_pago_rec1_en) {
        await enviarRecordatorioPago(lead, 1);
        db.prepare('UPDATE leads SET notif_pago_rec1_en = ? WHERE id = ?').run(new Date().toISOString(), lead.id);
      }
      if (elapsed >= PAGO_REC2 && !lead.notif_pago_rec2_en) {
        await enviarRecordatorioPago(lead, 2);
        db.prepare('UPDATE leads SET notif_pago_rec2_en = ? WHERE id = ?').run(new Date().toISOString(), lead.id);
      }
      if (elapsed >= PAGO_REC3 && !lead.notif_pago_rec3_en) {
        await enviarRecordatorioPago(lead, 3);
        db.prepare('UPDATE leads SET notif_pago_rec3_en = ? WHERE id = ?').run(new Date().toISOString(), lead.id);
      }
    }
  } catch (err) {
    console.error('Error en procesarRecordatoriosPago:', err.message);
  }
}

// Ejecutar cada minuto
setInterval(procesarNotificacionesAgendamiento, 60 * 1000);
setInterval(procesarRecordatoriosPago, 60 * 1000);
console.log('Scheduler de notificaciones de agendamiento iniciado');
console.log('Scheduler de recordatorios de pago 5RA iniciado');
