import { NextFunction, Request, Response } from 'express';
import { decodificarToken } from '../utils/jwt';

export default function autenticarCliente(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.get('Authorization') || '';
  const [tipo, token] = authHeader.split(' ');

  if (tipo !== 'Bearer' || !token) {
    res.status(401).json({ erro: 'Informe o token de autenticação no header Authorization: Bearer <token>.' });
    return;
  }

  let payload;
  try {
    payload = decodificarToken(token);
  } catch {
    res.status(401).json({ erro: 'Token inválido.' });
    return;
  }

  if (!payload?.sub) {
    res.status(401).json({ erro: 'Token inválido.' });
    return;
  }

  req.clienteToken = token;
  req.clienteIdToken = payload.sub;
  req.clienteSlugToken = typeof payload.slug === 'string' ? payload.slug : undefined;
  next();
}
