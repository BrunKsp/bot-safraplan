// Orquestrador da conversa: liga sessão + histórico + IA + handlers de intenção.
// É o "maestro" do bot — chamado uma vez por mensagem recebida do WhatsApp.

const session = require('./session');
const history = require('./history');
const { extrairIntencao } = require('./ai');
const { tratarIntencao } = require('../intents/handlers');

const MENSAGEM_SEM_CADASTRO =
  'Não encontrei nenhuma conta SafraPlan vinculada a este número. Cadastre-se no aplicativo usando este mesmo número de WhatsApp e me chame de novo depois. 🌱';

// Roda `fn(sessao)` e, se o backend responder 401 (token expirado), tenta autenticar de novo
// pelo celular (login por celular não depende de senha, então dá pra renovar automaticamente)
// e roda uma única vez mais.
async function comRenovacaoDeToken(sessao, fn) {
  try {
    return await fn(sessao);
  } catch (err) {
    if (err.response?.status === 401) {
      const novaSessao = await session.autenticarCelular(sessao.celular);
      if (novaSessao) return fn(novaSessao);
    }
    throw err;
  }
}

async function handleMessage({ celular, texto }) {
  let sessao = await session.buscarSessao(celular);

  if (!sessao) {
    sessao = await session.autenticarCelular(celular);
    if (!sessao) return MENSAGEM_SEM_CADASTRO;
  }

  await history.salvarMensagem(celular, 'user', texto);

  let campos;

  if (sessao.contexto_pendente) {
    // A mensagem atual é a resposta à pergunta que o bot fez (ex: "qual fazenda?").
    const { campos: camposAnteriores, perguntando } = sessao.contexto_pendente;
    campos = { ...camposAnteriores, [perguntando]: texto.trim() };
  } else {
    const historico = await history.getRecentHistory(celular);
    campos = await extrairIntencao(historico, texto);
  }

  let resultado;
  try {
    resultado = await comRenovacaoDeToken(sessao, (s) => tratarIntencao(s, campos));
  } catch (err) {
    console.error(`Erro ao processar mensagem de ${celular}:`, err.response?.data || err.message);
    resultado = { resposta: 'Tive um problema para registrar isso no sistema. Tenta de novo em instantes?' };
  }

  if (resultado.perguntar) {
    await session.salvarContextoPendente(celular, { campos, perguntando: resultado.perguntar });
    await history.salvarMensagem(celular, 'assistant', resultado.pergunta);
    return resultado.pergunta;
  }

  await session.limparContextoPendente(celular);
  await history.salvarMensagem(celular, 'assistant', resultado.resposta);
  return resultado.resposta;
}

module.exports = { handleMessage };
