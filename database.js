import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// En producción (Railway) usar volumen persistente vía DATA_DIR
// En desarrollo local cae a ../database (mismo path histórico)
const dbDir  = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'database')
  : path.join(__dirname, '../database');
const dbPath = path.join(dbDir, 'inmobia.db');

// Asegurar que el directorio exista
mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(dbPath);

// WAL para mejor concurrencia
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT NOT NULL,
    email     TEXT UNIQUE NOT NULL,
    password  TEXT NOT NULL,
    rol       TEXT DEFAULT 'admin',
    creado_en TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS propiedades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo         TEXT NOT NULL,
    descripcion    TEXT,
    tipo           TEXT NOT NULL,
    operacion      TEXT NOT NULL,
    precio         REAL NOT NULL,
    moneda         TEXT DEFAULT 'GTQ',
    mantenimiento  INTEGER DEFAULT 0,
    iva            INTEGER DEFAULT 0,
    zona           TEXT,
    municipio      TEXT,
    direccion      TEXT,
    habitaciones   INTEGER DEFAULT 0,
    banos          REAL DEFAULT 0,
    parqueos       INTEGER DEFAULT 0,
    metros         REAL DEFAULT 0,
    amueblado      INTEGER DEFAULT 0,
    mascota        INTEGER DEFAULT 0,
    piscina        INTEGER DEFAULT 0,
    gimnasio       INTEGER DEFAULT 0,
    seguridad      INTEGER DEFAULT 0,
    estado         TEXT DEFAULT 'activo',
    destacado      INTEGER DEFAULT 0,
    creado_en      TEXT DEFAULT (datetime('now')),
    actualizado_en TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS imagenes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    propiedad_id INTEGER NOT NULL,
    url          TEXT NOT NULL,
    principal    INTEGER DEFAULT 0,
    orden        INTEGER DEFAULT 0,
    FOREIGN KEY (propiedad_id) REFERENCES propiedades(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contactos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    propiedad_id INTEGER,
    nombre       TEXT,
    telefono     TEXT,
    email        TEXT,
    mensaje      TEXT,
    creado_en    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config_email (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS suscriptores_email (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre    TEXT,
    email     TEXT UNIQUE NOT NULL,
    activo    INTEGER DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now'))
  );
`);

// Valores por defecto de configuración de email
const defaultEmailConfig = {
  email_principal:      process.env.EMAIL_PRINCIPAL || 'mottionstudios@gmail.com',
  campos_suscriptores:  JSON.stringify(['nombre','telefono','tipo_propiedad','zona','dias','horario','dia_hora','comentario']),
  mensaje_personalizado: 'Nueva solicitud de visita recibida a través de InmobIA.',
};
for (const [clave, valor] of Object.entries(defaultEmailConfig)) {
  try { db.prepare('INSERT OR IGNORE INTO config_email (clave, valor) VALUES (?, ?)').run(clave, valor); } catch {}
}

// Migraciones: agregar columnas nuevas si no existen
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mantenimiento INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN iva INTEGER DEFAULT 0`); } catch {}
// Características únicas
try { db.exec(`ALTER TABLE propiedades ADD COLUMN linea_blanca INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN jardin INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN patio INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN bodega INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN dormitorio_servicio INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN sala_familiar INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN no_mascota INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN no_linea_blanca INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN nombre_proyecto TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mapa_url TEXT DEFAULT ''`); } catch {}
// ¿Qué incluye?
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_estufa INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_refrigeradora INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_torre_lavadora INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_lavadora INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_lamparas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_cortinas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_espejos INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_calentador INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN descripcion_persuasiva TEXT DEFAULT ''`); } catch {}
// Mantenimiento incluye
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mant_agua INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mant_basura INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mant_seguridad INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mant_areas_comunes INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN mant_areas_verdes INTEGER DEFAULT 0`); } catch {}
// Requisitos
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_dpi INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_constancia INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_estados_cuenta INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_formulario INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_fiador INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_antecedentes INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_renas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_infornet INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_deposito INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_contrato_1ano INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_notario INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_valor_contrato TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN req_adicionales TEXT DEFAULT ''`); } catch {}
// Amenidades extendidas
try { db.exec(`ALTER TABLE propiedades ADD COLUMN piscina_techada INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN piscina_climatizada INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN salon_social INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN business_center INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN juegos_ninos INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN pergola INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN area_social INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN sala_reuniones INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN churrasqueras INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN tiendas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN coworking INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN yoga_deck INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN sky_lounge INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN terraza_panoramica INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN firepit INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN senderos INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN bosque INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN parque INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN bbq_lounge INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN bistro_lounge INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN terraza_jardin INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN salon_lounge INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN garita INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN otra_amenidad TEXT DEFAULT ''`); } catch {}
// Nuevas columnas admin
try { db.exec(`ALTER TABLE propiedades ADD COLUMN estudio INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN areas_verdes INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN parqueo_visitas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN inc_aire_acondicionado INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN parque_mascotas INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN deck INTEGER DEFAULT 0`); } catch {}

try { db.exec(`ALTER TABLE propiedades ADD COLUMN usuario_id INTEGER DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN publicado_inmobia INTEGER DEFAULT 0`); } catch {}

// Columnas adicionales para asesores
try { db.exec(`ALTER TABLE usuarios ADD COLUMN telefono TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN zona TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN operacion TEXT DEFAULT 'ambas'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN slug TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN plan TEXT DEFAULT 'gratis'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN score REAL DEFAULT 3.0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN bio TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN foto TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN tipo_asesor TEXT DEFAULT 'independiente'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN nit TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN usuario TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN tipos_ranking TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN tipo_doc TEXT DEFAULT 'dpi'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN pais_origen TEXT DEFAULT ''`); } catch {}

// Tabla de transacciones (propiedades vendidas/rentadas)
db.exec(`
  CREATE TABLE IF NOT EXISTS transacciones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    propiedad_id    INTEGER NOT NULL,
    tipo            TEXT DEFAULT 'venta',
    comprador       TEXT,
    asesor          TEXT,
    fecha_transaccion TEXT,
    precio_final    REAL,
    moneda          TEXT DEFAULT 'GTQ',
    comision        REAL,
    notas           TEXT,
    creado_en       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (propiedad_id) REFERENCES propiedades(id) ON DELETE CASCADE
  )
`);

// Columnas de personalización del portal del asesor
try { db.exec(`ALTER TABLE usuarios ADD COLUMN logo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN empresa TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN hero_color_izq TEXT DEFAULT '#1e2d4a'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN hero_color_der TEXT DEFAULT '#2a3f6b'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN hero_imagen TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN btn_estilo TEXT DEFAULT 'color'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN btn_whatsapp INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN btn_agendar INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN btn_mensaje INTEGER DEFAULT 1`); } catch {}

// Redes sociales del asesor
try { db.exec(`ALTER TABLE usuarios ADD COLUMN red_fb TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN red_ig TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN red_tiktok TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN red_linkedin TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN vis_fb INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN vis_ig INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN vis_tiktok INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN vis_linkedin INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN cuenta_banco TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN cuenta_numero TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN cuenta_tipo TEXT DEFAULT 'monetaria'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN cuenta_titular TEXT DEFAULT ''`); } catch {}

// Normalizar valor 'alquiler' → 'renta' en propiedades existentes
try { db.exec(`UPDATE propiedades SET operacion = 'renta' WHERE operacion = 'alquiler'`); } catch {}
// Migrar leads creados desde portal que quedaron en 'agendado' → 'nuevo'
try { db.exec(`UPDATE leads SET etapa = 'nuevo' WHERE etapa = 'agendado' AND origen = 'portal'`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN datos_extra TEXT DEFAULT ''`); } catch {}

// Tabla de leads del CRM del asesor
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    asesor_id        INTEGER NOT NULL,
    nombre           TEXT,
    email            TEXT,
    telefono         TEXT,
    mensaje          TEXT,
    tipo             TEXT DEFAULT 'mensaje',
    propiedad_id     INTEGER,
    propiedad_titulo TEXT,
    etapa            TEXT DEFAULT 'nuevo',
    origen           TEXT DEFAULT 'portal',
    fecha_visita     TEXT,
    notas            TEXT,
    creado_en        TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (asesor_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )
`);

// Sección Servicios del portal
try { db.exec(`ALTER TABLE usuarios ADD COLUMN servicios_activo INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN servicios_titulo TEXT DEFAULT 'Mis Servicios'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN servicios_data TEXT DEFAULT ''`); } catch {}

// Sección Testimonios del portal
try { db.exec(`ALTER TABLE usuarios ADD COLUMN testimonios_activo INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN testimonios_titulo TEXT DEFAULT 'Testimonios'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN testimonios_data TEXT DEFAULT ''`); } catch {}

// Tabla de propiedades destacadas en el hero (plan Premium)
db.exec(`
  CREATE TABLE IF NOT EXISTS destacados_hero (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    propiedad_id INTEGER NOT NULL,
    asesor_id    INTEGER NOT NULL,
    imagen_url   TEXT NOT NULL,
    activado_en  TEXT DEFAULT (datetime('now')),
    expira_en    TEXT NOT NULL,
    mostrado     INTEGER DEFAULT 0,
    FOREIGN KEY (propiedad_id) REFERENCES propiedades(id) ON DELETE CASCADE,
    FOREIGN KEY (asesor_id)    REFERENCES usuarios(id)    ON DELETE CASCADE
  )
`);

// Tabla de magic links para panel del cliente
db.exec(`
  CREATE TABLE IF NOT EXISTS magic_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT UNIQUE NOT NULL,
    email      TEXT NOT NULL,
    lead_id    INTEGER,
    expira_en  TEXT NOT NULL,
    usado      INTEGER DEFAULT 0,
    creado_en  TEXT DEFAULT (datetime('now'))
  )
`);

// Tabla de tokens de recuperación de contraseña
db.exec(`
  CREATE TABLE IF NOT EXISTS password_resets (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    email     TEXT NOT NULL,
    token     TEXT UNIQUE NOT NULL,
    expira_en TEXT NOT NULL,
    usado     INTEGER DEFAULT 0,
    creado_en TEXT DEFAULT (datetime('now'))
  )
`);

// Tabla de calificaciones de clientes a asesores
db.exec(`
  CREATE TABLE IF NOT EXISTS calificaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    asesor_id   INTEGER NOT NULL,
    estrellas   INTEGER NOT NULL,
    razones     TEXT DEFAULT '',
    comentario  TEXT DEFAULT '',
    creado_en   TEXT DEFAULT (datetime('now')),
    UNIQUE(lead_id)
  )
`);

// Columna calificacion_cliente en leads
try { db.exec(`ALTER TABLE leads ADD COLUMN calificacion_cliente INTEGER DEFAULT NULL`); } catch {}

// Columnas extendidas en calificaciones (detalle de la visita)
try { db.exec(`ALTER TABLE calificaciones ADD COLUMN interes TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE calificaciones ADD COLUMN asesor_estrellas INTEGER DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE calificaciones ADD COLUMN asesor_razones TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE calificaciones ADD COLUMN asesor_comentario TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE calificaciones ADD COLUMN recomendaria TEXT DEFAULT ''`); } catch {}

// Columnas de cierre en leads
try { db.exec(`ALTER TABLE leads ADD COLUMN valor_cierre REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_pct REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_bruta REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_inmobia REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_asesor REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN cerrado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN moneda_cierre TEXT DEFAULT 'GTQ'`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN asesor_referente_id INTEGER DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_referente REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN referente_fecha_comision TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN referente_comision_recibida_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_coordinada_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN modelo TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN requerimiento_id INTEGER DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_captor_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_referente_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_comision_pct REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_precio_estimado REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_moneda TEXT DEFAULT 'GTQ'`); } catch {}
try { db.exec(`ALTER TABLE requerimientos ADD COLUMN municipio TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE requerimientos ADD COLUMN colonia TEXT DEFAULT NULL`); } catch {}

// Capa 5 · Bitácora de seguimiento por asesor
try { db.exec(`ALTER TABLE leads ADD COLUMN razon_cierre TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ultima_bitacora_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_realizada_en TEXT DEFAULT NULL`); } catch {}

// Doble verificación del cierre — el cliente confirma independientemente del asesor
try { db.exec(`ALTER TABLE leads ADD COLUMN cierre_declarado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN cierre_verificacion_estado TEXT DEFAULT NULL`); } catch {} // 'pendiente' | 'confirmado' | 'disputado'
try { db.exec(`ALTER TABLE leads ADD COLUMN cierre_verificado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN cierre_disputa_motivo TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN cierre_cliente_observacion TEXT DEFAULT NULL`); } catch {}

// Cobro de comisión — link de pago generado tras verificación cliente
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_checkout_id TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_link_pago TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_link_creado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_pagada_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_estado TEXT DEFAULT NULL`); } catch {} // 'pendiente' | 'pagada' | 'vencida' | 'por_recibir' | 'programada' | 'recibida'

// Modelo 1D — InmobIA paga al asesor por transferencia bancaria
try { db.exec(`ALTER TABLE leads ADD COLUMN pago_asesor_fecha_programada TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN pago_asesor_pagado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN pago_asesor_referencia TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN pago_asesor_notas TEXT DEFAULT NULL`); } catch {}
// Configuración de la plataforma
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_settings (
    clave   TEXT PRIMARY KEY,
    valor   TEXT
  )
`);
try { db.prepare("INSERT OR IGNORE INTO platform_settings (clave, valor) VALUES ('soporte_whatsapp', '')").run(); } catch {}
try { db.prepare("INSERT OR IGNORE INTO platform_settings (clave, valor) VALUES ('soporte_nombre', 'InmobIA')").run(); } catch {}

// Rechazo de convenio colaborativo — persiste para notificaciones fiables
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_rechazado_por TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_rechazado_nota TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_rechazado_en TEXT DEFAULT NULL`); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_bitacora (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    asesor_id   INTEGER NOT NULL,
    tipo        TEXT NOT NULL,
    nota        TEXT,
    creado_en   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id)   REFERENCES leads(id)    ON DELETE CASCADE,
    FOREIGN KEY (asesor_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_bitacora_lead ON lead_bitacora(lead_id)`); } catch {}

// Modelo 5RA · Requerimientos publicados por asesores Premium
db.exec(`
  CREATE TABLE IF NOT EXISTS requerimientos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asesor_id INTEGER NOT NULL,
    cliente_nombre TEXT,
    cliente_telefono TEXT,
    cliente_email TEXT,
    operacion TEXT,
    tipo_propiedad TEXT,
    municipio TEXT,
    zona TEXT,
    colonia TEXT,
    precio_min REAL,
    precio_max REAL,
    moneda TEXT DEFAULT 'GTQ',
    habitaciones INTEGER,
    banos INTEGER,
    metros_min INTEGER,
    caracteristicas TEXT,
    notas TEXT,
    estado TEXT DEFAULT 'activo',
    vence_en TEXT,
    renovaciones INTEGER DEFAULT 0,
    cerrado_lead_id INTEGER DEFAULT NULL,
    creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (asesor_id) REFERENCES usuarios(id)
  )
`);
try { db.exec(`ALTER TABLE propiedades ADD COLUMN codigo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN precio_sin_linea_blanca REAL DEFAULT 0`); } catch {}

// Configuración de comisión por propiedad (gestionada por admin)
try { db.exec(`ALTER TABLE propiedades ADD COLUMN comision_pct REAL DEFAULT 5.0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN descuenta_mantenimiento INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN valor_mantenimiento REAL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN notas_convenio TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN convenio_aceptado_en TEXT`); } catch {}
try { db.exec(`ALTER TABLE propiedades ADD COLUMN compartir_tripartito INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN permitir_similares_otros INTEGER DEFAULT 0`); } catch {}

// Suscripción Premium vía Recurrente
try { db.exec(`ALTER TABLE usuarios ADD COLUMN recurrente_checkout_id TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN recurrente_subscription_id TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN premium_estado TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN premium_activado_en TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN premium_renovacion_en TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN dpi_archivo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN dpi_subido_en TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN dpi_estado TEXT DEFAULT 'pendiente'`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN dpi_rechazado_razon TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN acred_cbr INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN acred_cbr_codigo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN acred_gpi INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN acred_gpi_codigo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN mostrar_zonas INTEGER DEFAULT 1`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN sexo TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN hero_opacidad REAL DEFAULT 0.45`); } catch {}
try { db.exec(`ALTER TABLE usuarios ADD COLUMN codigo_asesor TEXT DEFAULT ''`); } catch {}

// Bitácora de pagos (historial)
db.exec(`
  CREATE TABLE IF NOT EXISTS pagos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id        INTEGER NOT NULL,
    tipo              TEXT NOT NULL,
    monto             REAL,
    moneda            TEXT DEFAULT 'GTQ',
    estado            TEXT,
    recurrente_id     TEXT,
    recurrente_evento TEXT,
    payload           TEXT,
    creado_en         TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )
`);

// Idempotencia de webhooks Recurrente — evita procesar el mismo evento dos veces
db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_eventos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id    TEXT UNIQUE NOT NULL,
    tipo         TEXT,
    usuario_id   INTEGER,
    procesado_en TEXT DEFAULT (datetime('now')),
    resultado    TEXT
  )
`);
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_evento_id ON webhook_eventos(evento_id)`); } catch {}

// Compartir propiedades 1D con asesores
try { db.exec(`ALTER TABLE propiedades ADD COLUMN compartido_1d INTEGER DEFAULT 0`); } catch {}

// Solicitudes de asesores para propiedades 1D compartidas por admin
db.exec(`
  CREATE TABLE IF NOT EXISTS solicitudes_1d (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    propiedad_id  INTEGER NOT NULL,
    asesor_id     INTEGER NOT NULL,
    estado        TEXT DEFAULT 'activa',
    creado_en     TEXT DEFAULT (datetime('now')),
    UNIQUE(propiedad_id, asesor_id)
  )
`);

// Propiedades subidas por admin que quedaron con publicado_inmobia=0 → corregir a 1
try {
  db.exec(`UPDATE propiedades SET publicado_inmobia = 1 WHERE publicado_inmobia = 0 AND usuario_id IN (SELECT id FROM usuarios WHERE rol = 'admin')`);
} catch {}

// Flujo progresivo 5RA/4T en leads
try { db.exec(`ALTER TABLE leads ADD COLUMN papeleria_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN papeleria_estado TEXT DEFAULT NULL`); } catch {} // aprobada | no-aprobada | incompleta
try { db.exec(`ALTER TABLE leads ADD COLUMN papeleria_comentario TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN contrato_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN deposito_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN deposito_monto REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN deposito_comprobante TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN primera_renta_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN primera_renta_monto REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN primera_renta_comprobante TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_pago_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_pago_tipo TEXT DEFAULT NULL`); } catch {} // en-linea | transferencia | deposito
try { db.exec(`ALTER TABLE leads ADD COLUMN comision_comprobante TEXT DEFAULT NULL`); } catch {}

// Seguimiento de agendamiento de visita después de convenio
try { db.exec(`ALTER TABLE leads ADD COLUMN convenio_aceptado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN agendamiento_nota TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_agendamiento_24h_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_agendamiento_72h_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_agendamiento_120h_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN alerta_inmobia_144h_en TEXT DEFAULT NULL`); } catch {}
// Recordatorios de fechas de pago (post-contrato 5RA)
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_pago_rec1_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_pago_rec2_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN notif_pago_rec3_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_captor_confirmada_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_referente_confirmada_en TEXT DEFAULT NULL`); } catch {}
// Mapa de progreso del referente (5RA)
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_resultado_visita TEXT DEFAULT NULL`); } catch {}   // interesado | negociando | no-interesado
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_resultado_visita_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_resultado_nota TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_papeleria_estado TEXT DEFAULT NULL`); } catch {}   // entregada | completa | incompleta
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_papeleria_fecha TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_contrato_confirmado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_contrato_fecha_firma TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_contrato_hora_firma TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_contrato_lugar_firma TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_cierre_valor REAL DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_cierre_declarado_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_comision_pago_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_comision_pago_tipo TEXT DEFAULT NULL`); } catch {} // en-linea | transferencia
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_fecha_cobro_acordada TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_fecha_pago_inmobia TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN ref_fecha_pago_referente TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN contrato_hora TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN contrato_lugar TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_cliente_confirmada_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN visita_cliente_magic_enviado_en TEXT DEFAULT NULL`); } catch {}
// Consultas desde el portal de propiedades (modelo 70/30)
try { db.exec(`ALTER TABLE leads ADD COLUMN consulta_telefono_desbloqueado INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN consulta_followup_enviado_en TEXT DEFAULT NULL`); } catch {}
// Etapa de seguimiento propia de InmobIA (independiente de la etapa del asesor)
try { db.exec(`ALTER TABLE leads ADD COLUMN etapa_inmobia TEXT DEFAULT 'nuevo'`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN nota_inmobia TEXT DEFAULT NULL`); } catch {}

// Encuesta post-visita (InmobIA pregunta al cliente automáticamente al confirmar visita)
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_enviada_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_respondida_en TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_estrellas INTEGER DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_interes TEXT DEFAULT NULL`); } catch {}   // muy-interesado | interesado | poco-interesado | no-interesado
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_razones TEXT DEFAULT NULL`); } catch {}   // JSON array
try { db.exec(`ALTER TABLE leads ADD COLUMN encuesta_comentario TEXT DEFAULT NULL`); } catch {}

// Tabla de mensajes de consulta (conversación asesor ↔ cliente vía InmobIA)
db.exec(`
  CREATE TABLE IF NOT EXISTS consulta_mensajes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    de         TEXT NOT NULL,
    mensaje    TEXT NOT NULL,
    enviado_wa INTEGER DEFAULT 0,
    enviado_en TEXT DEFAULT NULL,
    creado_en  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  )
`);

// ── Score InmobIA: historial mensual por asesor ────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS score_mensual (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    asesor_id           INTEGER NOT NULL,
    mes                 TEXT NOT NULL,
    score_final         REAL DEFAULT 0,
    area_perfil         REAL DEFAULT 0,
    area_propiedades    REAL DEFAULT 0,
    area_cierres        REAL DEFAULT 0,
    area_calificaciones REAL DEFAULT 0,
    area_visitas        REAL DEFAULT 0,
    area_leads          REAL DEFAULT 0,
    area_respuesta      REAL DEFAULT 0,
    area_referidos      REAL DEFAULT 0,
    area_colaborativos  REAL DEFAULT 0,
    calculado_en        TEXT DEFAULT (datetime('now')),
    UNIQUE(asesor_id, mes),
    FOREIGN KEY (asesor_id) REFERENCES usuarios(id) ON DELETE CASCADE
  )
`);

// actualizado_en en leads: se actualiza cada vez que el asesor mueve el lead
try { db.exec(`ALTER TABLE leads ADD COLUMN actualizado_en TEXT DEFAULT NULL`); } catch {}

// Opinión del asesor post-visita + chat de seguimiento
try { db.exec(`ALTER TABLE leads ADD COLUMN asesor_interes TEXT DEFAULT NULL`); } catch {}        // no-interesado|no-seguro|lo-pensara|interesado|muy-interesado
try { db.exec(`ALTER TABLE leads ADD COLUMN asesor_interes_comentario TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN asesor_fecha_seguimiento TEXT DEFAULT NULL`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN asesor_interes_en TEXT DEFAULT NULL`); } catch {}

// referidor_id en usuarios: quién refirió a este asesor
try { db.exec(`ALTER TABLE usuarios ADD COLUMN referidor_id INTEGER DEFAULT NULL`); } catch {}

// Requerimientos originados por clientes desde panel-cliente
try { db.exec(`ALTER TABLE requerimientos ADD COLUMN fuente TEXT DEFAULT 'asesor'`); } catch {}
try { db.exec(`ALTER TABLE requerimientos ADD COLUMN cliente_origen_email TEXT DEFAULT NULL`); } catch {}

// leads_bonus_referidos: leads extra acumulados por referir asesores
try { db.exec(`ALTER TABLE usuarios ADD COLUMN leads_bonus_referidos INTEGER DEFAULT 0`); } catch {}

// Perfil de búsqueda del cliente (ajustable desde panel-cliente)
db.exec(`
  CREATE TABLE IF NOT EXISTS perfiles_cliente (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    email               TEXT UNIQUE NOT NULL,
    tipo                TEXT DEFAULT '',
    operacion           TEXT DEFAULT '',
    presupuesto_max     REAL DEFAULT NULL,
    moneda              TEXT DEFAULT 'GTQ',
    zonas               TEXT DEFAULT '',
    habitaciones_min    INTEGER DEFAULT 0,
    banos_min           REAL DEFAULT 0,
    acepta_mascotas     INTEGER DEFAULT 0,
    acepta_financiamiento INTEGER DEFAULT 0,
    activo_en_red       INTEGER DEFAULT 0,
    notas               TEXT DEFAULT '',
    actualizado_en      TEXT DEFAULT (datetime('now'))
  )
`);

// Tabla de notificaciones internas del asesor
db.exec(`
  CREATE TABLE IF NOT EXISTS notificaciones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id  INTEGER NOT NULL,
    tipo        TEXT NOT NULL,
    titulo      TEXT NOT NULL,
    mensaje     TEXT NOT NULL,
    leida       INTEGER DEFAULT 0,
    creado_en   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
  )
`);

// Auto-promover primer usuario a admin si no existe ningún admin
try {
  const anyAdmin = db.prepare("SELECT id FROM usuarios WHERE rol = 'admin' LIMIT 1").get();
  if (!anyAdmin) {
    const firstUser = db.prepare("SELECT id, email FROM usuarios ORDER BY id ASC LIMIT 1").get();
    if (firstUser) {
      db.prepare("UPDATE usuarios SET rol = 'admin' WHERE id = ?").run(firstUser.id);
      console.log(`[DB] Auto-promovido a admin: ${firstUser.email}`);
    }
  }
} catch(e) { console.error('[DB] Error en migración admin:', e.message); }

console.log('Base de datos inicializada:', dbPath);
