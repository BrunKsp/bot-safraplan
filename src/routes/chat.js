// Acesso direto ao mesmo motor de conversa do WhatsApp (sessão + histórico + IA + handlers),
// só que por HTTP puro — sem passar pela Meta/WAHA. Protegido pelo JWT que o cliente já usa
// no restante do SafraPlan; o celular no corpo identifica de qual sessão/histórico reaproveitar.
const express = require('express');
const router = express.Router();
const autenticarCliente = require('../middlewares/autenticarCliente');
const session = require('../services/session');
const { handleMessage } = require('../services/conversation');
const { gerarInsightsDoMes } = require('../services/insights');

router.use(autenticarCliente);

async function resolverSessaoAutorizada(req, res, celular) {
  if (!celular) {
    res.status(400).json({ erro: 'Informe o celular no corpo da requisição.' });
    return null;
  }

  let sessao = await session.buscarSessao(celular);
  if (!sessao) {
    sessao = await session.autenticarCelular(celular);
  }

  if (!sessao) {
    res.status(404).json({ erro: 'Não encontrei nenhuma conta SafraPlan vinculada a este número.' });
    return null;
  }

  if (sessao.cliente_id !== req.clienteIdToken) {
    res.status(403).json({ erro: 'Esse token não pertence a este número.' });
    return null;
  }

  return sessao;
}

router.post('/mensagem', async (req, res) => {
  const { celular, mensagem } = req.body || {};

  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ erro: 'Informe a mensagem no corpo da requisição.' });
  }

  const sessao = await resolverSessaoAutorizada(req, res, celular);
  if (!sessao) return;

  try {
    const resposta = await handleMessage({ celular, texto: mensagem.trim() });
    res.json({ resposta });
  } catch (err) {
    console.error(`Erro ao processar mensagem direta de ${celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para processar essa mensagem agora. Tenta de novo em instantes?' });
  }
});

router.post('/insights', async (req, res) => {
  const { celular } = req.body || {};

  const sessao = await resolverSessaoAutorizada(req, res, celular);
  if (!sessao) return;

  try {
    const { insights, resumo } = await gerarInsightsDoMes(sessao);
    res.json({ insights, resumo });
  } catch (err) {
    console.error(`Erro ao gerar insights de ${celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para calcular seus insights agora. Tenta de novo em instantes?' });
  }
});

module.exports = router;
