// Campos extras anexados ao Request pelo bot: `rawBody` (body cru, pra validar a assinatura
// HMAC da Meta) e `clienteToken`/`clienteIdToken` (extraídos do JWT pelo middleware de auth
// das rotas de /chat).
declare namespace Express {
  export interface Request {
    rawBody?: Buffer;
    clienteToken?: string;
    clienteIdToken?: string;
  }
}
