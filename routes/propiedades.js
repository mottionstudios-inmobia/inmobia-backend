import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../database.js';
import { authMiddleware, leerUsuarioToken } from '../auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();
const ESTADOS_PROPIEDAD = ['activo', 'inactivo', 'vendido', 'pendiente', 'alquilado'];

const uploadsDir = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'uploads')
  : path.join(__dirname, '../../public/uploads');

function puedeGestionarPropiedad(req, propiedad) {
  return req.usuario?.rol === 'admin' || propiedad?.usuario_id === req.usuario?.id;
}

function validarGestionPropiedad(req, res, propiedad) {
  if (!propiedad) {
    res.status(404).json({ error: 'Propiedad no encontrada' });
    return false;
  }
  if (!puedeGestionarPropiedad(req, propiedad)) {
    res.status(403).json({ error: 'Sin permiso' });
    return false;
  }
  return true;
}

function notificarPropiedadAlquilada(propiedad) {
  if (!propiedad?.id) return 0;
  const solicitantes = db.prepare(`
    SELECT DISTINCT s.asesor_id
    FROM solicitudes_1d s
    WHERE s.propiedad_id = ?
  `).all(propiedad.id);
  if (!solicitantes.length) return 0;

  const stmt = db.prepare(`
    INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje, creado_en)
    VALUES (?, 'propiedad_alquilada', 'Propiedad InmobIA alquilada', ?, datetime('now'))
  `);
  const tx = db.transaction((rows) => {
    rows.forEach(s => stmt.run(
      s.asesor_id,
      `La propiedad "${propiedad.titulo || 'Propiedad InmobIA'}" fue marcada como alquilada por InmobIA. Ya no está disponible para ofrecerla a nuevos clientes.`
    ));
    db.prepare("UPDATE solicitudes_1d SET estado = 'alquilada' WHERE propiedad_id = ?").run(propiedad.id);
  });
  tx(solicitantes);
  return solicitantes.length;
}

function resolverOrigenComision(req, propExistente = null) {
  const solicitado = req.body.origen_comision === 'plus_one' ? 'plus_one' : 'directa';
  const existentePlusOne = propExistente?.origen_comision === 'plus_one';
  if (solicitado === 'plus_one' && existentePlusOne) {
    return { origen_comision: 'plus_one', comision_disponible_pct: 50 };
  }
  if (solicitado !== 'plus_one') {
    if (existentePlusOne && req.usuario?.rol !== 'admin') {
      const asesor = db.prepare('SELECT puede_plus_one FROM usuarios WHERE id = ? AND rol = ?').get(req.usuario.id, 'asesor');
      if (!asesor?.puede_plus_one) {
        return { origen_comision: 'plus_one', comision_disponible_pct: 50 };
      }
    }
    return { origen_comision: 'directa', comision_disponible_pct: 100 };
  }
  if (req.usuario?.rol === 'admin') {
    return { origen_comision: 'plus_one', comision_disponible_pct: 50 };
  }
  const asesor = db.prepare('SELECT puede_plus_one FROM usuarios WHERE id = ? AND rol = ?').get(req.usuario.id, 'asesor');
  if (!asesor?.puede_plus_one) {
    const err = new Error('Las propiedades +1 requieren aprobación previa de InmobIA.');
    err.status = 403;
    throw err;
  }
  return { origen_comision: 'plus_one', comision_disponible_pct: 50 };
}

// Configuración de subida de imágenes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `prop_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const permitidos = /jpeg|jpg|png|webp/;
    cb(null, permitidos.test(file.mimetype));
  }
});

// Genera código de propiedad: TIPO+OP+ZONA-SEQ-SUFIJO
// Admin → sufijo INMOBIA (modelo 1D), asesor → sufijo A####
function generarCodigoProp(userId, tipo, operacion, zona, municipio) {
  const tipoMap = { apartamento: 'A', casa: 'C', terreno: 'T', oficina: 'O', local: 'L', 'local comercial': 'L', bodega: 'B', penthouse: 'P', townhouse: 'W', 'dúplex': 'D', duplex: 'D' };
  const tipoLetra = tipoMap[(tipo || '').toLowerCase()] || 'X';
  const opLetra   = (operacion || '').toLowerCase() === 'renta' ? 'R' : 'V';
  const digits    = (zona || '').replace(/\D/g, '');
  const zonaRef   = digits
    ? digits
    : (municipio ? municipio.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase() : 'XX');

  const count = userId
    ? (db.prepare(`SELECT COUNT(*) as c FROM propiedades WHERE usuario_id = ? AND LOWER(tipo) = LOWER(?) AND LOWER(operacion) = LOWER(?)`).get(userId, tipo, operacion)?.c || 0) + 1
    : 1;
  const seq = String(count).padStart(2, '0');

  const usuario = userId ? db.prepare('SELECT rol, codigo_asesor FROM usuarios WHERE id = ?').get(userId) : null;
  const sufijo = usuario?.rol === 'admin'
    ? 'INMOBIA'
    : `A${usuario?.codigo_asesor || '0000'}`;

  return `${tipoLetra}${opLetra}${zonaRef}-${seq}-${sufijo}`;
}

// ── GET /api/propiedades/mis-propiedades  (asesor autenticado)
router.get('/mis-propiedades', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
    (SELECT COUNT(*) FROM imagenes WHERE propiedad_id = p.id) AS total_imagenes
    FROM propiedades p WHERE p.usuario_id = ? ORDER BY p.creado_en DESC
  `).all(req.usuario.id);
  res.json({ propiedades: rows });
});

// ── PATCH /api/propiedades/:id/toggle-tripartito  (Premium — compartir con otros asesores)
router.patch('/:id/toggle-tripartito', authMiddleware, (req, res) => {
  const { compartir } = req.body;
  const p = db.prepare('SELECT usuario_id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (p.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  const u = db.prepare('SELECT plan FROM usuarios WHERE id = ?').get(req.usuario.id);
  if (compartir && u?.plan !== 'premium') return res.status(403).json({ error: 'Solo asesores Premium pueden compartir con otros asesores' });
  db.prepare('UPDATE propiedades SET compartir_tripartito = ? WHERE id = ?').run(compartir ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── GET /api/propiedades/tripartito  (pública — propiedades de otros asesores compartidas en red)
router.get('/tripartito', (req, res) => {
  const { tipo, operacion, excluir_asesor } = req.query;
  if (!tipo || !operacion) return res.json({ propiedades: [] });
  const rows = db.prepare(`
    SELECT p.*, u.nombre AS asesor_nombre, u.slug AS asesor_slug,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal
    FROM propiedades p JOIN usuarios u ON u.id = p.usuario_id
    WHERE p.compartir_tripartito = 1 AND p.estado IN ('activo','pendiente')
      AND p.tipo = ? AND p.operacion = ? AND p.usuario_id != ?
    ORDER BY p.creado_en DESC LIMIT 30
  `).all(tipo, operacion, Number(excluir_asesor) || 0);
  res.json({ propiedades: rows });
});

// ── PATCH /api/propiedades/:id/toggle-publicacion  (asesor autenticado)
router.patch('/:id/toggle-publicacion', authMiddleware, (req, res) => {
  const { publicado, comision_pct, notas_convenio } = req.body;
  const p = db.prepare('SELECT usuario_id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (p.usuario_id !== req.usuario.id) return res.status(403).json({ error: 'Sin permiso' });
  if (publicado) {
    db.prepare(`UPDATE propiedades SET publicado_inmobia = 1,
      comision_pct = COALESCE(?, comision_pct),
      notas_convenio = COALESCE(?, notas_convenio),
      convenio_aceptado_en = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(comision_pct ?? null, notas_convenio ?? null, req.params.id);
  } else {
    db.prepare('UPDATE propiedades SET publicado_inmobia = 0 WHERE id = ?').run(req.params.id);
  }
  res.json({ mensaje: 'Estado actualizado' });
});

// ── GET /api/propiedades  (pública, con filtros)
router.get('/', (req, res) => {
  const { tipo, operacion, zona, busqueda, minPrecio, maxPrecio, habitaciones, parqueos, estado, limit = 50, offset = 0 } = req.query;

  // estado=todos solo omite filtros internos cuando lo solicita un admin autenticado.
  const usuarioToken = leerUsuarioToken(req);
  const estadoFiltro = estado === 'todos' ? null : (estado || null);
  const mostrarTodos = estado === 'todos' && usuarioToken?.rol === 'admin';

  let sql = 'SELECT p.*, (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal FROM propiedades p WHERE 1=1';
  const params = [];

  if (!mostrarTodos) {
    if (estadoFiltro) {
      if (usuarioToken?.rol !== 'admin' && !['activo', 'pendiente'].includes(estadoFiltro)) {
        sql += ' AND 1=0';
      } else {
        sql += ' AND p.estado = ? AND p.publicado_inmobia = 1'; params.push(estadoFiltro);
      }
    } else {
      // Público: solo activo+pendiente y marcadas "En InmobIA"
      sql += " AND p.estado IN ('activo','pendiente') AND p.publicado_inmobia = 1";
    }
  }

  if (tipo)         { sql += ' AND p.tipo = ?';            params.push(tipo); }
  if (operacion)    { sql += ' AND p.operacion = ?';       params.push(operacion); }
  if (zona)         { sql += ' AND p.zona LIKE ?';         params.push(`%${zona}%`); }
  if (busqueda)     { sql += ' AND (p.titulo LIKE ? OR p.zona LIKE ?)'; params.push(`%${busqueda}%`, `%${busqueda}%`); }
  if (minPrecio)    { sql += ' AND p.precio >= ?';         params.push(Number(minPrecio)); }
  if (maxPrecio)    { sql += ' AND p.precio <= ?';         params.push(Number(maxPrecio)); }
  if (habitaciones) { sql += ' AND p.habitaciones >= ?';   params.push(Number(habitaciones)); }
  if (parqueos)     { sql += ' AND p.parqueos >= ?';       params.push(Number(parqueos)); }

  // Query de conteo con los mismos filtros (sin LIMIT/OFFSET)
  let countSql = 'SELECT COUNT(*) as total FROM propiedades p WHERE 1=1';
  const countParams = [];
  if (!mostrarTodos) {
    if (estadoFiltro) {
      if (usuarioToken?.rol !== 'admin' && !['activo', 'pendiente'].includes(estadoFiltro)) {
        countSql += ' AND 1=0';
      } else {
        countSql += ' AND p.estado = ? AND p.publicado_inmobia = 1'; countParams.push(estadoFiltro);
      }
    } else {
      countSql += " AND p.estado IN ('activo','pendiente') AND p.publicado_inmobia = 1";
    }
  }
  if (tipo)         { countSql += ' AND p.tipo = ?';          countParams.push(tipo); }
  if (operacion)    { countSql += ' AND p.operacion = ?';     countParams.push(operacion); }
  if (zona)         { countSql += ' AND p.zona LIKE ?';       countParams.push(`%${zona}%`); }
  if (busqueda)     { countSql += ' AND (p.titulo LIKE ? OR p.zona LIKE ?)'; countParams.push(`%${busqueda}%`, `%${busqueda}%`); }
  if (minPrecio)    { countSql += ' AND p.precio >= ?';       countParams.push(Number(minPrecio)); }
  if (maxPrecio)    { countSql += ' AND p.precio <= ?';       countParams.push(Number(maxPrecio)); }
  if (habitaciones) { countSql += ' AND p.habitaciones >= ?'; countParams.push(Number(habitaciones)); }
  if (parqueos)     { countSql += ' AND p.parqueos >= ?';     countParams.push(Number(parqueos)); }

  sql += ' ORDER BY p.destacado DESC, p.creado_en DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const propiedades = db.prepare(sql).all(...params);
  const total = db.prepare(countSql).get(...countParams).total;

  res.json({ total, propiedades });
});

// ── GET /api/propiedades/inmobia/compartidas  (asesor autenticado — propiedades 1D compartidas por admin)
router.get('/inmobia/compartidas', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
      (SELECT COUNT(*) FROM imagenes WHERE propiedad_id = p.id) AS total_imagenes,
      s.id AS solicitud_id, s.estado AS solicitud_estado
    FROM propiedades p
    LEFT JOIN solicitudes_1d s ON s.propiedad_id = p.id AND s.asesor_id = ?
    WHERE p.compartido_1d = 1 AND p.estado IN ('activo','pendiente','alquilado')
    ORDER BY p.creado_en DESC
  `).all(req.usuario.id);

  const getImagenes = db.prepare('SELECT id, url, principal, orden FROM imagenes WHERE propiedad_id = ? ORDER BY principal DESC, orden ASC');
  const propiedades = rows.map(p => ({ ...p, imagenes: getImagenes.all(p.id) }));

  res.json({ propiedades });
});

// ── GET /api/propiedades/mis-propiedades-1d  (asesor — propiedades 1D que ha solicitado, para su portal)
router.get('/mis-propiedades-1d', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT url FROM imagenes WHERE propiedad_id = p.id AND principal = 1 LIMIT 1) AS imagen_principal,
      (SELECT COUNT(*) FROM imagenes WHERE propiedad_id = p.id) AS total_imagenes
    FROM propiedades p
    JOIN solicitudes_1d s ON s.propiedad_id = p.id AND s.asesor_id = ?
    WHERE s.estado = 'activa' AND p.compartido_1d = 1 AND p.estado IN ('activo','pendiente')
    ORDER BY p.creado_en DESC
  `).all(req.usuario.id);
  res.json({ propiedades: rows });
});

// ── POST /api/propiedades/:id/solicitar-1d  (asesor — solicitar propiedad compartida 1D)
router.post('/:id/solicitar-1d', authMiddleware, (req, res) => {
  const propId = Number(req.params.id);
  const p = db.prepare('SELECT id, compartido_1d, estado FROM propiedades WHERE id = ?').get(propId);
  if (!p || !p.compartido_1d) return res.status(404).json({ error: 'Propiedad no disponible' });
  if (!['activo', 'pendiente'].includes(p.estado)) return res.status(400).json({ error: 'Esta propiedad ya no está disponible' });
  try {
    db.prepare('INSERT INTO solicitudes_1d (propiedad_id, asesor_id) VALUES (?, ?)').run(propId, req.usuario.id);
  } catch {
    return res.json({ ok: true, ya_solicitada: true });
  }
  res.json({ ok: true });
});

// ── DELETE /api/propiedades/:id/solicitar-1d  (asesor — cancelar solicitud 1D)
router.delete('/:id/solicitar-1d', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM solicitudes_1d WHERE propiedad_id = ? AND asesor_id = ?').run(Number(req.params.id), req.usuario.id);
  res.json({ ok: true });
});

// ── GET /api/propiedades/:id  (pública)
router.get('/:id', (req, res) => {
  const propiedad = db.prepare('SELECT * FROM propiedades WHERE id = ?').get(req.params.id);
  if (!propiedad) return res.status(404).json({ error: 'Propiedad no encontrada' });

  // Número secuencial por tipo (conteo de propiedades del mismo tipo con id <= actual)
  const { seq_tipo } = db.prepare(
    'SELECT COUNT(*) AS seq_tipo FROM propiedades WHERE tipo = ? AND id <= ?'
  ).get(propiedad.tipo, propiedad.id);

  const imagenes = db.prepare('SELECT * FROM imagenes WHERE propiedad_id = ? ORDER BY principal DESC, orden ASC').all(propiedad.id);
  const dueno = db.prepare('SELECT permitir_similares_otros, slug FROM usuarios WHERE id = ?').get(propiedad.usuario_id);
  res.json({ ...propiedad, seq_tipo, imagenes,
    asesor_permitir_similares: dueno?.permitir_similares_otros || 0,
    asesor_slug: dueno?.slug || '' });
});

const uploadFields = upload.fields([
  { name: 'imagenes', maxCount: 30 },
  { name: 'imagen_principal', maxCount: 1 }
]);

// Wrapper que convierte errores de multer en respuestas JSON
function uploadFieldsSafe(req, res, next) {
  uploadFields(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Has superado el límite de 30 fotografías por propiedad. Elimina algunas e intenta de nuevo.' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Una o más imágenes superan el tamaño máximo de 10 MB.' });
    }
    return res.status(400).json({ error: 'Error al subir archivos: ' + err.message });
  });
}

// ── POST /api/propiedades  (protegida)
router.post('/', authMiddleware, uploadFieldsSafe, (req, res) => {
  const {
    titulo, nombre_proyecto = '', descripcion_persuasiva = '', descripcion = '', tipo, operacion, precio, moneda = 'GTQ',
    zona = '', municipio = '', colonia = '', direccion = '', mapa_url = '', habitaciones = 0, banos = 0,
    parqueos = 0, metros = 0, amueblado = 0, mascota = 0,
    piscina = 0, gimnasio = 0, seguridad = 0, destacado = 0, mantenimiento = 0, iva = 0, impuestos = 0,
    bodega = 0, dormitorio_servicio = 0, sala_familiar = 0,
    no_mascota = 0, no_linea_blanca = 0,
    linea_blanca = 0, jardin = 0, patio = 0,
    piscina_techada = 0, piscina_climatizada = 0, salon_social = 0, business_center = 0,
    juegos_ninos = 0, pergola = 0, area_social = 0, sala_reuniones = 0, churrasqueras = 0,
    tiendas = 0, coworking = 0, yoga_deck = 0, sky_lounge = 0, terraza_panoramica = 0,
    firepit = 0, senderos = 0, bosque = 0, parque = 0, bbq_lounge = 0,
    bistro_lounge = 0, terraza_jardin = 0, salon_lounge = 0,
    garita = 0, otra_amenidad = '',
    estudio = 0, areas_verdes = 0, parqueo_visitas = 0,
    parque_mascotas = 0, deck = 0, casa_club = 0, bar_deck = 0,
    doble_garita_seguridad = 0, cancha_polideportiva = 0,
    inc_estufa = 0, inc_refrigeradora = 0, inc_torre_lavadora = 0, inc_lavadora = 0,
    inc_lamparas = 0, inc_cortinas = 0, inc_espejos = 0, inc_calentador = 0,
    inc_aire_acondicionado = 0,
    mant_agua = 0, mant_basura = 0, mant_seguridad = 0, mant_areas_comunes = 0, mant_areas_verdes = 0,
    req_dpi = 0, req_constancia = 0, req_estados_cuenta = 0, req_formulario = 0, req_fiador = 0,
    req_antecedentes = 0, req_renas = 0, req_infornet = 0, req_deposito = 0,
    req_contrato_1ano = 0, req_notario = 0, req_valor_contrato = '', req_adicionales = '',
    publicado_inmobia: _pub = 0
  } = req.body;

  if (!titulo || !tipo || !operacion || !precio)
    return res.status(400).json({ error: 'Título, tipo, operación y precio son requeridos' });

  // Extraer usuario_id del token (asesores)
  const usuario_id = req.usuario?.id || null;

  // Propiedades subidas por admin siempre van publicadas en InmobIA (modelo 1D)
  const publicado_inmobia = req.usuario?.rol === 'admin' ? 1 : Number(_pub);
  let origenCfg;
  try {
    origenCfg = resolverOrigenComision(req);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const codigoProp = generarCodigoProp(usuario_id, tipo, operacion, zona, municipio);

  const n = v => Number(v);
  let result;
  try {
  result = db.prepare(`
    INSERT INTO propiedades
      (titulo, nombre_proyecto, descripcion_persuasiva, descripcion, tipo, operacion, precio, moneda, zona, municipio, colonia, direccion, mapa_url,
       habitaciones, banos, parqueos, metros, amueblado, mascota, piscina, gimnasio, seguridad,
       destacado, mantenimiento, iva, impuestos, bodega, dormitorio_servicio, sala_familiar,
       no_mascota, no_linea_blanca, linea_blanca, jardin, patio, garita,
       piscina_techada, piscina_climatizada, salon_social, business_center, juegos_ninos,
       pergola, area_social, sala_reuniones, churrasqueras, tiendas, coworking,
       yoga_deck, sky_lounge, terraza_panoramica, firepit, senderos, bosque, parque,
       bbq_lounge, bistro_lounge, terraza_jardin, salon_lounge, otra_amenidad,
        estudio, areas_verdes, parqueo_visitas, parque_mascotas, deck,
        casa_club, bar_deck, doble_garita_seguridad, cancha_polideportiva,
       inc_estufa, inc_refrigeradora, inc_torre_lavadora, inc_lavadora,
       inc_lamparas, inc_cortinas, inc_espejos, inc_calentador, inc_aire_acondicionado,
       mant_agua, mant_basura, mant_seguridad, mant_areas_comunes, mant_areas_verdes,
       req_dpi, req_constancia, req_estados_cuenta, req_formulario, req_fiador,
       req_antecedentes, req_renas, req_infornet, req_deposito, req_contrato_1ano, req_notario,
       req_valor_contrato, req_adicionales, usuario_id, publicado_inmobia, codigo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(titulo, nombre_proyecto, descripcion_persuasiva, descripcion, tipo, operacion, n(precio), moneda, zona, municipio, colonia, direccion, mapa_url,
         n(habitaciones), n(banos), n(parqueos), n(metros), n(amueblado), n(mascota), n(piscina),
         n(gimnasio), n(seguridad), n(destacado), n(mantenimiento), n(iva), n(impuestos),
         n(bodega), n(dormitorio_servicio), n(sala_familiar),
         n(no_mascota), n(no_linea_blanca), n(linea_blanca), n(jardin), n(patio), n(garita),
         n(piscina_techada), n(piscina_climatizada), n(salon_social), n(business_center), n(juegos_ninos),
         n(pergola), n(area_social), n(sala_reuniones), n(churrasqueras), n(tiendas), n(coworking),
         n(yoga_deck), n(sky_lounge), n(terraza_panoramica), n(firepit), n(senderos), n(bosque), n(parque),
         n(bbq_lounge), n(bistro_lounge), n(terraza_jardin), n(salon_lounge), otra_amenidad,
         n(estudio), n(areas_verdes), n(parqueo_visitas), n(parque_mascotas), n(deck),
         n(casa_club), n(bar_deck), n(doble_garita_seguridad), n(cancha_polideportiva),
         n(inc_estufa), n(inc_refrigeradora), n(inc_torre_lavadora), n(inc_lavadora),
         n(inc_lamparas), n(inc_cortinas), n(inc_espejos), n(inc_calentador), n(inc_aire_acondicionado),
         n(mant_agua), n(mant_basura), n(mant_seguridad), n(mant_areas_comunes), n(mant_areas_verdes),
         n(req_dpi), n(req_constancia), n(req_estados_cuenta), n(req_formulario), n(req_fiador),
         n(req_antecedentes), n(req_renas), n(req_infornet), n(req_deposito), n(req_contrato_1ano), n(req_notario),
         req_valor_contrato, req_adicionales, usuario_id, n(publicado_inmobia), codigoProp);
  } catch (e) {
    console.error('Error INSERT propiedad:', e.message);
    return res.status(500).json({ error: 'Error al guardar la propiedad: ' + e.message });
  }

  const propiedadId = result.lastInsertRowid;

  // Campo adicional: precio alternativo sin línea blanca
  db.prepare('UPDATE propiedades SET precio_sin_linea_blanca = ? WHERE id = ?')
    .run(Number(req.body.precio_sin_linea_blanca) || 0, propiedadId);
  db.prepare('UPDATE propiedades SET origen_comision = ?, comision_disponible_pct = ? WHERE id = ?')
    .run(origenCfg.origen_comision, origenCfg.comision_disponible_pct, propiedadId);

  // Convenio de comisión (se guarda al aceptar el convenio desde el formulario)
  if (req.body.convenio_aceptado === '1' || req.body.convenio_aceptado === 1) {
    db.prepare(`UPDATE propiedades SET comision_pct = COALESCE(?, comision_pct),
      notas_convenio = ?, convenio_aceptado_en = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.comision_pct != null && req.body.comision_pct !== '' ? Number(req.body.comision_pct) : null,
           req.body.notas_convenio || '', propiedadId);
  }

  // Guardar imagen principal separada
  const insertImg = db.prepare('INSERT INTO imagenes (propiedad_id, url, principal, orden) VALUES (?,?,?,?)');
  const principalFiles = req.files?.imagen_principal || [];
  const galeriaFiles   = req.files?.imagenes || [];
  let orden = 0;
  if (principalFiles.length) {
    insertImg.run(propiedadId, `/uploads/${principalFiles[0].filename}`, 1, orden++);
  }
  galeriaFiles.forEach(file => {
    insertImg.run(propiedadId, `/uploads/${file.filename}`, principalFiles.length ? 0 : orden === 0 ? 1 : 0, orden++);
  });

  // Sumar score si la propiedad tiene 5+ fotos (+0.5)
  const totalFotos = db.prepare('SELECT COUNT(*) AS n FROM imagenes WHERE propiedad_id = ?').get(propiedadId)?.n || 0;
  let scoreNuevoProp = null;
  if (totalFotos >= 5) {
    db.prepare('UPDATE usuarios SET score = MIN(5.0, MAX(1.0, ROUND(score + 0.5, 2))) WHERE id = ?').run(req.usuario.id);
    scoreNuevoProp = db.prepare('SELECT score FROM usuarios WHERE id = ?').get(req.usuario.id)?.score;
  }

  res.status(201).json({ id: propiedadId, mensaje: 'Propiedad creada exitosamente',
    ...(scoreNuevoProp !== null && { score_nuevo: scoreNuevoProp, score_accion: 'fotos', score_delta: 0.5 }) });
});

// ── PUT /api/propiedades/:id  (protegida)
router.put('/:id', authMiddleware, uploadFieldsSafe, (req, res) => {
  const { id } = req.params;
  const propExistente = db.prepare('SELECT id, codigo, usuario_id, origen_comision, estado, titulo FROM propiedades WHERE id = ?').get(id);
  if (!validarGestionPropiedad(req, res, propExistente)) return;

  const {
    titulo, nombre_proyecto = '', descripcion_persuasiva = '', descripcion = '', tipo, operacion, precio, moneda = 'GTQ',
    zona = '', municipio = '', colonia = '', direccion = '', mapa_url = '', habitaciones = 0, banos = 0, parqueos = 0,
    metros = 0, amueblado = 0, mascota = 0, piscina = 0, gimnasio = 0, seguridad = 0, estado = 'activo', destacado = 0, mantenimiento = 0, iva = 0, impuestos = 0,
    bodega = 0, dormitorio_servicio = 0, sala_familiar = 0,
    no_mascota = 0, no_linea_blanca = 0,
    linea_blanca = 0, jardin = 0, patio = 0,
    piscina_techada = 0, piscina_climatizada = 0, salon_social = 0, business_center = 0,
    juegos_ninos = 0, pergola = 0, area_social = 0, sala_reuniones = 0, churrasqueras = 0,
    tiendas = 0, coworking = 0, yoga_deck = 0, sky_lounge = 0, terraza_panoramica = 0,
    firepit = 0, senderos = 0, bosque = 0, parque = 0, bbq_lounge = 0,
    bistro_lounge = 0, terraza_jardin = 0, salon_lounge = 0,
    garita = 0, otra_amenidad = '',
    estudio = 0, areas_verdes = 0, parqueo_visitas = 0,
    parque_mascotas = 0, deck = 0, casa_club = 0, bar_deck = 0,
    doble_garita_seguridad = 0, cancha_polideportiva = 0,
    inc_estufa = 0, inc_refrigeradora = 0, inc_torre_lavadora = 0, inc_lavadora = 0,
    inc_lamparas = 0, inc_cortinas = 0, inc_espejos = 0, inc_calentador = 0,
    inc_aire_acondicionado = 0,
    mant_agua = 0, mant_basura = 0, mant_seguridad = 0, mant_areas_comunes = 0, mant_areas_verdes = 0,
    req_dpi = 0, req_constancia = 0, req_estados_cuenta = 0, req_formulario = 0, req_fiador = 0,
    req_antecedentes = 0, req_renas = 0, req_infornet = 0, req_deposito = 0,
    req_contrato_1ano = 0, req_notario = 0, req_valor_contrato = '', req_adicionales = '',
    publicado_inmobia: _pub2 = 0
  } = req.body;

  if (!ESTADOS_PROPIEDAD.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  const publicado_inmobia = req.usuario?.rol === 'admin' ? 1 : Number(_pub2);
  let origenCfg;
  try {
    origenCfg = resolverOrigenComision(req, propExistente);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  // Regenerar código si la propiedad no tenía uno
  if (!propExistente.codigo && tipo && operacion) {
    const uid = propExistente.usuario_id || req.usuario?.id;
    const nuevoCodigoPut = generarCodigoProp(uid, tipo, operacion, zona, municipio);
    db.prepare('UPDATE propiedades SET codigo = ? WHERE id = ?').run(nuevoCodigoPut, id);
  }

  const n = v => Number(v);
  try {
  db.prepare(`
    UPDATE propiedades SET
      titulo=?, nombre_proyecto=?, descripcion_persuasiva=?, descripcion=?, tipo=?, operacion=?, precio=?, moneda=?,
      zona=?, municipio=?, colonia=?, direccion=?, mapa_url=?, habitaciones=?, banos=?, parqueos=?,
      metros=?, amueblado=?, mascota=?, piscina=?, gimnasio=?, seguridad=?,
      estado=?, destacado=?, mantenimiento=?, iva=?, impuestos=?,
      bodega=?, dormitorio_servicio=?, sala_familiar=?,
      no_mascota=?, no_linea_blanca=?, linea_blanca=?, jardin=?, patio=?, garita=?,
      piscina_techada=?, piscina_climatizada=?, salon_social=?, business_center=?, juegos_ninos=?,
      pergola=?, area_social=?, sala_reuniones=?, churrasqueras=?, tiendas=?, coworking=?,
      yoga_deck=?, sky_lounge=?, terraza_panoramica=?, firepit=?, senderos=?, bosque=?, parque=?,
      bbq_lounge=?, bistro_lounge=?, terraza_jardin=?, salon_lounge=?, otra_amenidad=?,
      estudio=?, areas_verdes=?, parqueo_visitas=?, parque_mascotas=?, deck=?,
      casa_club=?, bar_deck=?, doble_garita_seguridad=?, cancha_polideportiva=?,
      inc_estufa=?, inc_refrigeradora=?, inc_torre_lavadora=?, inc_lavadora=?,
      inc_lamparas=?, inc_cortinas=?, inc_espejos=?, inc_calentador=?, inc_aire_acondicionado=?,
      mant_agua=?, mant_basura=?, mant_seguridad=?, mant_areas_comunes=?, mant_areas_verdes=?,
      req_dpi=?, req_constancia=?, req_estados_cuenta=?, req_formulario=?, req_fiador=?,
      req_antecedentes=?, req_renas=?, req_infornet=?, req_deposito=?, req_contrato_1ano=?, req_notario=?,
      req_valor_contrato=?, req_adicionales=?, publicado_inmobia=?,
      actualizado_en=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(titulo, nombre_proyecto, descripcion_persuasiva, descripcion, tipo, operacion, n(precio), moneda,
         zona, municipio, colonia, direccion, mapa_url, n(habitaciones), n(banos), n(parqueos),
         n(metros), n(amueblado), n(mascota), n(piscina), n(gimnasio), n(seguridad),
         estado, n(destacado), n(mantenimiento), n(iva), n(impuestos),
         n(bodega), n(dormitorio_servicio), n(sala_familiar),
         n(no_mascota), n(no_linea_blanca), n(linea_blanca), n(jardin), n(patio), n(garita),
         n(piscina_techada), n(piscina_climatizada), n(salon_social), n(business_center), n(juegos_ninos),
         n(pergola), n(area_social), n(sala_reuniones), n(churrasqueras), n(tiendas), n(coworking),
         n(yoga_deck), n(sky_lounge), n(terraza_panoramica), n(firepit), n(senderos), n(bosque), n(parque),
         n(bbq_lounge), n(bistro_lounge), n(terraza_jardin), n(salon_lounge), otra_amenidad,
         n(estudio), n(areas_verdes), n(parqueo_visitas), n(parque_mascotas), n(deck),
         n(casa_club), n(bar_deck), n(doble_garita_seguridad), n(cancha_polideportiva),
         n(inc_estufa), n(inc_refrigeradora), n(inc_torre_lavadora), n(inc_lavadora),
         n(inc_lamparas), n(inc_cortinas), n(inc_espejos), n(inc_calentador), n(inc_aire_acondicionado),
         n(mant_agua), n(mant_basura), n(mant_seguridad), n(mant_areas_comunes), n(mant_areas_verdes),
         n(req_dpi), n(req_constancia), n(req_estados_cuenta), n(req_formulario), n(req_fiador),
         n(req_antecedentes), n(req_renas), n(req_infornet), n(req_deposito), n(req_contrato_1ano), n(req_notario),
         req_valor_contrato, req_adicionales, n(publicado_inmobia), id);
  } catch (e) {
    console.error('Error UPDATE propiedad:', e.message);
    return res.status(500).json({ error: 'Error al actualizar la propiedad: ' + e.message });
  }

  // Campo adicional: precio alternativo sin línea blanca
  db.prepare('UPDATE propiedades SET precio_sin_linea_blanca = ? WHERE id = ?')
    .run(Number(req.body.precio_sin_linea_blanca) || 0, id);
  db.prepare('UPDATE propiedades SET origen_comision = ?, comision_disponible_pct = ? WHERE id = ?')
    .run(origenCfg.origen_comision, origenCfg.comision_disponible_pct, id);

  // Convenio de comisión
  if (req.body.convenio_aceptado === '1' || req.body.convenio_aceptado === 1) {
    db.prepare(`UPDATE propiedades SET comision_pct = COALESCE(?, comision_pct),
      notas_convenio = ?, convenio_aceptado_en = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.body.comision_pct != null && req.body.comision_pct !== '' ? Number(req.body.comision_pct) : null,
           req.body.notas_convenio || '', id);
  }

  // Eliminar imágenes de galería solo cuando el formulario confirma que está gestionando la galería.
  // Algunos formularios editan solo datos de la propiedad y no envían imagenes_conservar.
  const gestionaGaleria = req.body.imagenes_gestionadas === '1'
    || Object.prototype.hasOwnProperty.call(req.body, 'imagenes_conservar');
  if (gestionaGaleria) {
    let conservar = req.body.imagenes_conservar;
    if (conservar == null) conservar = [];
    else if (!Array.isArray(conservar)) conservar = [conservar];
    const galeriaActual = db.prepare('SELECT id, url FROM imagenes WHERE propiedad_id = ? AND principal = 0').all(id);
    const borrarStmt = db.prepare('DELETE FROM imagenes WHERE id = ?');
    galeriaActual.forEach(img => {
      if (!conservar.includes(img.url)) borrarStmt.run(img.id);
    });
  }

  // Agregar nuevas imágenes si se subieron
  const insertImg2 = db.prepare('INSERT INTO imagenes (propiedad_id, url, principal, orden) VALUES (?,?,?,?)');
  const principalFiles2 = req.files?.imagen_principal || [];
  const galeriaFiles2   = req.files?.imagenes || [];
  const hayPrincipal = db.prepare('SELECT id FROM imagenes WHERE propiedad_id = ? AND principal = 1').get(id);

  if (principalFiles2.length) {
    // Desmarcar principal actual y subir nueva
    db.prepare('UPDATE imagenes SET principal = 0 WHERE propiedad_id = ?').run(id);
    insertImg2.run(id, `/uploads/${principalFiles2[0].filename}`, 1, 0);
  }
  galeriaFiles2.forEach((file, i) => {
    insertImg2.run(id, `/uploads/${file.filename}`, !hayPrincipal && !principalFiles2.length && i === 0 ? 1 : 0, i + 1);
  });

  const notificacionesEnviadas = estado === 'alquilado' && propExistente.estado !== 'alquilado'
    ? notificarPropiedadAlquilada({ ...propExistente, titulo })
    : 0;

  res.json({ mensaje: 'Propiedad actualizada exitosamente', notificaciones_enviadas: notificacionesEnviadas });
});

// ── PATCH /api/propiedades/:id/comision  (solo admin — configurar comisión)
router.patch('/:id/comision', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { comision_pct, descuenta_mantenimiento, valor_mantenimiento } = req.body;
  db.prepare(`UPDATE propiedades SET comision_pct = ?, descuenta_mantenimiento = ?, valor_mantenimiento = ? WHERE id = ?`)
    .run(comision_pct ?? 5, descuenta_mantenimiento ? 1 : 0, valor_mantenimiento ?? 0, req.params.id);
  res.json({ ok: true });
});

// ── PATCH /api/propiedades/:id/estado  (protegida — cambio rápido de estado/precio)
router.patch('/:id/estado', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { estado, precio } = req.body;
  if (estado !== undefined && !ESTADOS_PROPIEDAD.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const existe = db.prepare('SELECT id, usuario_id, estado, titulo FROM propiedades WHERE id = ?').get(id);
  if (!validarGestionPropiedad(req, res, existe)) return;

  if (estado !== undefined && precio !== undefined) {
    db.prepare('UPDATE propiedades SET estado=?, precio=?, actualizado_en=CURRENT_TIMESTAMP WHERE id=?').run(estado, Number(precio), id);
  } else if (estado !== undefined) {
    db.prepare('UPDATE propiedades SET estado=?, actualizado_en=CURRENT_TIMESTAMP WHERE id=?').run(estado, id);
  } else if (precio !== undefined) {
    db.prepare('UPDATE propiedades SET precio=?, actualizado_en=CURRENT_TIMESTAMP WHERE id=?').run(Number(precio), id);
  }
  const notificacionesEnviadas = estado === 'alquilado' && existe.estado !== 'alquilado'
    ? notificarPropiedadAlquilada(existe)
    : 0;
  res.json({ ok: true, notificaciones_enviadas: notificacionesEnviadas });
});

// ── PATCH /api/propiedades/:id/compartir-1d  (solo admin — compartir propiedad 1D con asesores)
router.patch('/:id/compartir-1d', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { compartir } = req.body;
  const p = db.prepare('SELECT id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Propiedad no encontrada' });
  db.prepare('UPDATE propiedades SET compartido_1d = ? WHERE id = ?').run(compartir ? 1 : 0, req.params.id);
  if (!compartir) {
    db.prepare('DELETE FROM solicitudes_1d WHERE propiedad_id = ?').run(req.params.id);
  }
  res.json({ ok: true });
});

// ── PATCH /api/propiedades/:id/toggle-inmobia-admin  (solo admin)
router.patch('/:id/toggle-inmobia-admin', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { publicado } = req.body;
  const p = db.prepare('SELECT id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Propiedad no encontrada' });
  db.prepare('UPDATE propiedades SET publicado_inmobia = ? WHERE id = ?').run(publicado ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ── DELETE /api/propiedades/:id  (protegida)
router.delete('/:id', authMiddleware, (req, res) => {
  const existe = db.prepare('SELECT id, usuario_id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!validarGestionPropiedad(req, res, existe)) return;

  db.prepare('DELETE FROM propiedades WHERE id = ?').run(req.params.id);
  res.json({ mensaje: 'Propiedad eliminada' });
});

// ── DELETE /api/propiedades/imagen/:imgId  (protegida)
router.delete('/imagen/:imgId', authMiddleware, (req, res) => {
  const img = db.prepare(`SELECT i.id, p.usuario_id FROM imagenes i JOIN propiedades p ON p.id = i.propiedad_id WHERE i.id = ?`).get(req.params.imgId);
  if (!validarGestionPropiedad(req, res, img)) return;
  db.prepare('DELETE FROM imagenes WHERE id = ?').run(req.params.imgId);
  res.json({ mensaje: 'Imagen eliminada' });
});

// ── PATCH /api/propiedades/imagen/:imgId/principal  (protegida)
router.patch('/imagen/:imgId/principal', authMiddleware, (req, res) => {
  const img = db.prepare(`SELECT i.propiedad_id, p.usuario_id FROM imagenes i JOIN propiedades p ON p.id = i.propiedad_id WHERE i.id = ?`).get(req.params.imgId);
  if (!validarGestionPropiedad(req, res, img)) return;
  db.prepare('UPDATE imagenes SET principal = 0 WHERE propiedad_id = ?').run(img.propiedad_id);
  db.prepare('UPDATE imagenes SET principal = 1 WHERE id = ?').run(req.params.imgId);
  res.json({ mensaje: 'Imagen principal actualizada' });
});

// ── PATCH /api/propiedades/imagenes/orden  (protegida)
router.patch('/imagenes/orden', authMiddleware, (req, res) => {
  const { ids } = req.body; // array de IDs en nuevo orden
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids requerido' });
  const placeholders = ids.map(() => '?').join(',');
  const imagenes = db.prepare(`SELECT i.id, i.propiedad_id, p.usuario_id FROM imagenes i JOIN propiedades p ON p.id = i.propiedad_id WHERE i.id IN (${placeholders})`).all(...ids);
  if (imagenes.length !== ids.length) return res.status(404).json({ error: 'Imagen no encontrada' });
  if (new Set(imagenes.map(img => img.propiedad_id)).size !== 1) return res.status(400).json({ error: 'Las imagenes deben pertenecer a una sola propiedad' });
  if (imagenes.some(img => !puedeGestionarPropiedad(req, img))) return res.status(403).json({ error: 'Sin permiso' });
  ids.forEach((id, i) => {
    db.prepare('UPDATE imagenes SET orden = ?, principal = ? WHERE id = ?').run(i, i === 0 ? 1 : 0, id);
  });
  res.json({ mensaje: 'Orden actualizado' });
});

// ── GET /api/propiedades/:id/transaccion  (protegida)
router.get('/:id/transaccion', authMiddleware, (req, res) => {
  const existe = db.prepare('SELECT id, usuario_id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!validarGestionPropiedad(req, res, existe)) return;
  const t = db.prepare('SELECT * FROM transacciones WHERE propiedad_id = ? ORDER BY creado_en DESC LIMIT 1').get(req.params.id);
  res.json(t || {});
});

// ── POST /api/propiedades/:id/transaccion  (protegida)
router.post('/:id/transaccion', authMiddleware, (req, res) => {
  const { tipo, comprador, asesor, fecha_transaccion, precio_final, moneda, comision, notas } = req.body;
  const existe = db.prepare('SELECT id, usuario_id FROM propiedades WHERE id = ?').get(req.params.id);
  if (!validarGestionPropiedad(req, res, existe)) return;

  // Borrar transacción previa y crear nueva
  db.prepare('DELETE FROM transacciones WHERE propiedad_id = ?').run(req.params.id);
  const r = db.prepare(`
    INSERT INTO transacciones (propiedad_id, tipo, comprador, asesor, fecha_transaccion, precio_final, moneda, comision, notas)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, tipo||'venta', comprador||'', asesor||'', fecha_transaccion||'', precio_final ? Number(precio_final) : null, moneda||'GTQ', comision ? Number(comision) : null, notas||'');
  res.json({ id: r.lastInsertRowid, ok: true });
});

export default router;
