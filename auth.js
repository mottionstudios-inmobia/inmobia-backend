import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'inmobia_secret_2024';

export function generarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, rol: usuario.rol },
    SECRET,
    { expiresIn: '30d' }
  );
}

export function leerUsuarioToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try {
    const token = header.split(' ')[1];
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

export function authMiddleware(req, res, next) {
  const usuario = leerUsuarioToken(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token requerido o inválido' });
  }
  req.usuario = usuario;
  next();
}