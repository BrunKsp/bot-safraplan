// Protege rotas internas chamadas pelo backend-safraplan (não expostas a usuários finais), usando
// o mesmo segredo compartilhado já usado na direção bot -> backend (WHATSAPP_BOT_SECRET), só que
// na direção inversa.
import { NextFunction, Request, Response } from 'express';

export default function autenticarServico(req: Request, res: Response, next: NextFunction): void {
  const segredoEsperado = process.env.WHATSAPP_BOT_SECRET;
  const segredoRecebido = req.get('x-integration-secret');

  if (!segredoEsperado || segredoRecebido !== segredoEsperado) {
    res.status(401).json({ erro: 'Acesso não autorizado.' });
    return;
  }

  next();
}
