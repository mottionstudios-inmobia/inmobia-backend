import express from 'express';
import { db } from '../database.js';
import { authMiddleware } from '../auth.js';

const router = express.Router();

// ── GET /api/settings  (público — cualquiera puede leer configuración pública)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT clave, valor FROM platform_settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  res.json(settings);
});

// ── PUT /api/settings  (solo admin)
router.put('/', authMiddleware, (req, res) => {
  if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Sin permiso' });
  const updates = req.body; // { clave: valor, ... }
  const stmt = db.prepare('INSERT OR REPLACE INTO platform_settings (clave, valor) VALUES (?, ?)');
  for (const [clave, valor] of Object.entries(updates)) {
    stmt.run(clave, valor ?? '');
  }
  res.json({ ok: true });
});

export default router;
