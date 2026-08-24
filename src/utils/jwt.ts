// Verifica a assinatura de um JWT emitido pelo backend-safraplan, usando o mesmo JWT_SECRET
// (compartilhado entre os dois serviços, mesmo padrão do WHATSAPP_BOT_SECRET). Sem isso, um JWT
// forjado (só base64, sem assinatura de verdade) seria aceito por qualquer rota que não faça
// nenhuma chamada ao backend-safraplan (ex: GET /chat/historico, que é 100% leitura local).

import jwt from 'jsonwebtoken';

export interface TokenPayload {
  sub: string;
  [claim: string]: unknown;
}

export function decodificarToken(token: string): TokenPayload {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET não definido nas variáveis de ambiente.');
  }

  return jwt.verify(token, secret) as TokenPayload;
}
