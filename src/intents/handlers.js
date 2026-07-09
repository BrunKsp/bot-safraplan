// Um handler por intenção: recebe a sessão (vínculo do celular com o cliente) e os campos
// extraídos pela IA, chama o backend-safraplan e devolve a resposta formatada para o WhatsApp.
//
// Quando falta uma informação (ex: qual fazenda), o handler retorna `perguntar` em vez de
// `resposta` — o orquestrador (conversation.js) salva isso como contexto pendente e, na próxima
// mensagem, reinvoca o mesmo handler com o campo preenchido.

const backendClient = require('../services/backendClient');
const session = require('../services/session');
const { resolverFazenda, resolverCategoria, resolverProduto } = require('./resolvers');

const moeda = (valor) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hojeISO = () => new Date().toISOString().slice(0, 10);

async function resolverFazendaOuPerguntar(sessao, campos) {
  const resultado = await resolverFazenda(sessao, sessao.token, campos.fazenda);

  if (resultado.erro) return { resposta: resultado.erro };
  if (resultado.precisaEscolher) return { perguntar: 'fazenda', pergunta: resultado.pergunta };

  return { fazenda: resultado.fazenda };
}

async function registrarDespesa(sessao, campos) {
  if (!campos.valor) return { resposta: 'Quanto foi o valor da despesa?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const categoria = await resolverCategoria(sessao.token, campos.categoria);

  await session.salvarFazendaPadrao(sessao.celular, fazenda.slug);

  const despesa = await backendClient.criarDespesa(sessao.token, {
    fazendaSlug: fazenda.slug,
    categoriaSlug: categoria.slug,
    descricao: campos.descricao || categoria.nome,
    valor: campos.valor,
    data: campos.data || hojeISO(),
    formaPagamento: campos.formaPagamento || 'OUTRO',
  });

  return {
    resposta: `Despesa registrada: ${moeda(despesa.valor)} em ${categoria.nome} na fazenda ${fazenda.nome}. ✅`,
  };
}

async function registrarContaPagar(sessao, campos) {
  if (!campos.valor) return { resposta: 'Quanto é o valor da conta a pagar?' };
  if (!campos.dataVencimento) return { resposta: 'Pra quando é o vencimento?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  await session.salvarFazendaPadrao(sessao.celular, fazenda.slug);

  const conta = await backendClient.criarContaPagar(sessao.token, {
    fazendaSlug: fazenda.slug,
    descricao: campos.descricao || 'Conta a pagar',
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    fornecedor: campos.fornecedor,
    formaPagamento: campos.formaPagamento,
  });

  return { resposta: `Conta a pagar registrada: ${moeda(conta.valor)}, vencimento em ${conta.dataVencimento}. ✅` };
}

async function registrarContaReceber(sessao, campos) {
  if (!campos.valor) return { resposta: 'Quanto é o valor a receber?' };
  if (!campos.dataVencimento) return { resposta: 'Pra quando é o previsto?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  await session.salvarFazendaPadrao(sessao.celular, fazenda.slug);

  const conta = await backendClient.criarContaReceber(sessao.token, {
    fazendaSlug: fazenda.slug,
    descricao: campos.descricao || 'Conta a receber',
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    comprador: campos.comprador,
  });

  return { resposta: `Conta a receber registrada: ${moeda(conta.valor)}, previsto para ${conta.dataVencimento}. ✅` };
}

async function registrarVenda(sessao, campos) {
  if (!campos.produto) return { resposta: 'O que você vendeu?' };
  if (!campos.quantidade) return { resposta: 'Qual a quantidade vendida?' };
  if (!campos.valor) return { resposta: 'Qual o preço unitário da venda?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const produtoResolvido = await resolverProduto(sessao.token, campos.produto);
  if (produtoResolvido.erro) return { resposta: produtoResolvido.erro };

  await session.salvarFazendaPadrao(sessao.celular, fazenda.slug);

  const venda = await backendClient.criarVenda(sessao.token, {
    fazendaSlug: fazenda.slug,
    produtoSlug: produtoResolvido.produto.slug,
    quantidade: campos.quantidade,
    unidadeMedida: campos.unidadeMedida || produtoResolvido.produto.unidadeMedida,
    precoUnitario: campos.valor,
    data: campos.data || hojeISO(),
    comprador: campos.comprador,
    gerarContaReceber: Boolean(campos.gerarContaReceber),
  });

  return {
    resposta: `Venda registrada: ${campos.quantidade} ${venda.unidadeMedida} de ${produtoResolvido.produto.nome} a ${moeda(campos.valor)} = ${moeda(venda.valorTotal)}. ✅`,
  };
}

async function consultarResumo(sessao) {
  const resumo = await backendClient.getResumoDashboard(sessao.token, {});

  return {
    resposta: [
      `Resumo de ${resumo.periodo.inicio} a ${resumo.periodo.fim}:`,
      `Despesas: ${moeda(resumo.totalDespesas)}`,
      `Receitas: ${moeda(resumo.totalReceitas)}`,
      `Saldo: ${moeda(resumo.saldo)}`,
      `Contas a pagar pendentes: ${resumo.contasPagarPendentes.quantidade} (${moeda(resumo.contasPagarPendentes.valor)})`,
      `Contas a receber pendentes: ${resumo.contasReceberPendentes.quantidade} (${moeda(resumo.contasReceberPendentes.valor)})`,
    ].join('\n'),
  };
}

async function consultarContasPagar(sessao) {
  const contas = await backendClient.listarContasPagar(sessao.token, { status: 'PENDENTE' });
  const lista = Array.isArray(contas) ? contas : contas.dados || [];

  if (lista.length === 0) return { resposta: 'Você não tem nenhuma conta a pagar pendente. 🎉' };

  const linhas = lista
    .slice(0, 10)
    .map((c) => `• ${c.descricao} — ${moeda(c.valor)} (vence ${c.dataVencimento}, status ${c.statusConta})`);

  return { resposta: `Suas contas a pagar:\n${linhas.join('\n')}` };
}

async function consultarPrecosMercado(sessao, campos) {
  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const precos = await backendClient.getPrecosMercado(sessao.token, fazenda.slug);

  if (precos.length === 0) {
    return { resposta: 'Ainda não tenho cotações para as culturas da sua fazenda. Tente novamente mais tarde.' };
  }

  const linhas = precos.map((p) => `• ${p.cultura}: ${moeda(p.preco)} (${p.unidade}) em ${p.praca}/${p.estado} — ${p.data}`);
  return { resposta: `Últimas cotações (${fazenda.nome}):\n${linhas.join('\n')}` };
}

const HANDLERS = {
  REGISTRAR_DESPESA: registrarDespesa,
  REGISTRAR_CONTA_PAGAR: registrarContaPagar,
  REGISTRAR_CONTA_RECEBER: registrarContaReceber,
  REGISTRAR_VENDA: registrarVenda,
  CONSULTAR_RESUMO: consultarResumo,
  CONSULTAR_CONTAS_PAGAR: consultarContasPagar,
  CONSULTAR_PRECOS_MERCADO: consultarPrecosMercado,
};

// Executa o handler da intenção. Intenções sem handler (SAUDACAO, AJUDA, NAO_ENTENDI) usam
// diretamente o campo `resposta` que a própria IA já preencheu.
// Erros de chamada ao backend-safraplan propagam de propósito — quem decide se tenta de novo
// (ex: token expirado) ou desiste é o orquestrador (conversation.js).
async function tratarIntencao(sessao, campos) {
  const handler = HANDLERS[campos.intent];

  if (!handler) {
    return { resposta: campos.resposta || 'Não entendi, pode reformular?' };
  }

  return handler(sessao, campos);
}

module.exports = { tratarIntencao };
