// Configuración central de los 5 modelos de negocio InmobIA.
// Single source of truth: splits, etiquetas, reglas de detección.
// Ver: MODELOS DE NEGOCIO

import { db } from '../database.js';

export const MODELOS = {
  '1D': {
    codigo: '1D',
    nombre: 'Propiedades de InmobIA',
    etiqueta: '50/50 · Interno',
    split: { inmobia: 0.50, asesor: 0.50, referente: 0 },
    requierePremium: null,
    convenio: 'Interno (sin convenio externo)',
    // REGLA: solo aplica a propiedades subidas directamente por un usuario con rol='admin'.
    // InmobIA gestiona la propiedad con el propietario, recibe el pago del cliente
    // y transfiere al asesor su 50% por transferencia bancaria.
  },
  '2A': {
    codigo: '2A',
    nombre: 'Propiedades de Asesores',
    etiqueta: '30/70 · Captor único',
    split: { inmobia: 0.30, asesor: 0.70, referente: 0 },
    requierePremium: null,
    convenio: 'Formulario 30/70',
  },
  '3S': {
    codigo: '3S',
    nombre: 'Suscripción Premium',
    etiqueta: 'Q399/mes',
    split: null, // no aplica — suscripción recurrente
    requierePremium: null,
    convenio: 'Suscripción mensual',
  },
  '4T': {
    codigo: '4T',
    nombre: 'Tripartito',
    etiqueta: '40/20/40 · Match InmobIA',
    split: { inmobia: 0.20, asesor: 0.40, referente: 0.40 },
    requierePremium: 'asesor_2', // el dueño de la propiedad
    convenio: 'Convenio tripartito',
  },
  '5RA': {
    codigo: '5RA',
    nombre: 'Red de Asesores',
    etiqueta: '45/5/45 · Requerimiento',
    split: { inmobia: 0.05, asesor: 0.45, referente: 0.45 },
    requierePremium: 'asesor_a', // publica requerimiento
    convenio: 'Convenio 45/5/45',
  },
  'directo': {
    codigo: 'directo',
    nombre: 'Cliente Directo',
    etiqueta: '100/0 · Asesor',
    split: { inmobia: 0, asesor: 1, referente: 0 },
    requierePremium: null,
    convenio: 'Sin convenio (cliente directo)',
    // REGLA: cliente llegó directamente al asesor sin pasar por Inmobia.
    // El asesor recibe el 100% de la comisión — Inmobia no cobra nada.
  },
};

// ── Helper: verifica si la propiedad fue subida directamente por un admin de InmobIA ──
// Requisito estricto del modelo 1D: la propiedad debe tener un usuario_id que apunte
// a un usuario con rol='admin'. Propiedades sin dueño o de asesores NO califican como 1D.
export function propiedadEsDeAdmin(propiedadId) {
  if (!propiedadId) return false;
  const prop = db.prepare('SELECT usuario_id FROM propiedades WHERE id = ?').get(propiedadId);
  if (!prop || !prop.usuario_id) return false;
  const dueno = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(prop.usuario_id);
  return dueno?.rol === 'admin';
}

// ── Detección del modelo en el momento del agendamiento ──
// Árbitro documentado en CLAUDE.md y MODELOS DE NEGOCIO:
//   1. requerimiento_id → 5RA
//   2. referente_slug → 4T
//   3. propiedad subida por admin de InmobIA → 1D
//   4. propiedad de un asesor (o sin dueño identificable) → 2A
export function detectarModelo({ propiedadId, referenteSlug, requerimientoId }) {
  if (requerimientoId) return '5RA';
  if (referenteSlug)   return '4T';
  if (propiedadId && propiedadEsDeAdmin(propiedadId)) return '1D';
  return '2A';
}

// ── Cálculo de comisiones según modelo ──
export function splitComision(modelo, comisionBruta) {
  const cfg = MODELOS[modelo];
  if (!cfg?.split) return { inmobia: 0, asesor: comisionBruta, referente: 0 };
  const inmobia   = Math.round(comisionBruta * cfg.split.inmobia);
  const referente = Math.round(comisionBruta * cfg.split.referente);
  const asesor    = comisionBruta - inmobia - referente;
  return { inmobia, asesor, referente };
}

export function etiquetaModelo(modelo) {
  return MODELOS[modelo]?.etiqueta || modelo || '';
}

export function nombreModelo(modelo) {
  return MODELOS[modelo]?.nombre || modelo || '';
}
