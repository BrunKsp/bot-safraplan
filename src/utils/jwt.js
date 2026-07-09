// Decodifica (sem verificar assinatura) o payload de um JWT emitido pelo backend-safraplan.
// A verificação de assinatura de verdade acontece no backend a cada chamada autenticada que
// fizermos com o token — aqui só precisamos ler claims como `sub` (clienteId).
function decodificarToken(token) {
  const payloadBase64 = token.split('.')[1];
  const payloadJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
  return JSON.parse(payloadJson);
}

module.exports = { decodificarToken };
