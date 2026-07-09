// Protege rotas de acesso direto (fora do fluxo de webhook do WhatsApp) exigindo o mesmo JWT
// que o cliente já usa no restante do SafraPlan. Não valida a assinatura aqui — só extrai o
// clienteId (claim `sub`) para o handler confirmar que o token corresponde ao celular informado.
// A validade de verdade do token é checada no backend-safraplan a cada chamada autenticada.
const { decodificarToken } = require('../utils/jwt');

function autenticarCliente(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  const [tipo, token] = authHeader.split(' ');

  if (tipo !== 'Bearer' || !token) {
    return res.status(401).json({ erro: 'Informe o token de autenticação no header Authorization: Bearer <token>.' });
  }

  let payload;
  try {
    payload = decodificarToken(token);
  } catch {
    return res.status(401).json({ erro: 'Token inválido.' });
  }

  if (!payload?.sub) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }

  req.clienteToken = token;
  req.clienteIdToken = payload.sub;
  next();
}

module.exports = autenticarCliente;
