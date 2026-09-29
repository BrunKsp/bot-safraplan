// Um handler por intenção: recebe a sessão (vínculo do celular com o cliente) e os campos
// extraídos pela IA, chama o backend-safraplan e devolve a resposta formatada para o WhatsApp.
//
// Quando falta uma informação (ex: qual fazenda), o handler retorna `perguntar` em vez de
// `resposta` — o orquestrador (conversation.js) salva isso como contexto pendente e, na próxima
// mensagem, reinvoca o mesmo handler com o campo preenchido.

import * as backendClient from '../services/backendClient';
import * as session from '../services/session';
import { resolverFazenda, resolverCategoria, resolverProduto } from './resolvers';
import { CamposExtraidos } from '../services/ai';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

export interface ResultadoIntencao {
  resposta?: string;
  perguntar?: string;
  pergunta?: string;
}

const moeda = (valor?: number) => Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hojeISO = () => new Date().toISOString().slice(0, 10);

// Horário de Brasília, independente do fuso do servidor (Render roda em UTC).
function saudacaoPorHorario(): string {
  const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  if (hora >= 5 && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

// Cumprimenta pelo primeiro nome do cliente (vindo da sessão, resolvida no login por celular) em
// vez de deixar a IA gerar uma saudação genérica sem saber quem é o produtor.
async function saudacao(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const primeiroNome = sessao.nome?.trim().split(' ')[0];
  const nomePart = primeiroNome ? `, ${primeiroNome}` : '';

  return {
    resposta: `${saudacaoPorHorario()}${nomePart}! Eu sou o SafraBot, seu assistente financeiro do SafraPlan. 🌱\nMe conta o que você quer registrar (despesa, conta a pagar/receber, venda) ou consultar (resumo, preços de mercado).`,
  };
}

async function resolverFazendaOuPerguntar(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao & { fazenda?: backendClient.Fazenda }> {
  const resultado = await resolverFazenda(sessao, sessao.token, campos.fazenda);

  if (resultado.erro) return { resposta: resultado.erro };
  if (resultado.precisaEscolher) return { perguntar: 'fazenda', pergunta: resultado.pergunta };

  return { fazenda: resultado.fazenda };
}

// Todo registro (despesa, conta a pagar/receber, venda) passa por aqui antes de gravar no
// backend — mostra um resumo do que foi entendido e só segue em frente quando `campos.confirmado`
// vier true (setado pelo orquestrador quando o produtor responde "sim"; ver conversation.ts).
// Isso existe porque a IA pode errar campo (ex: categoria), e sem confirmação isso ia direto pro
// banco sem o produtor perceber.
function pedirConfirmacao(linhas: Array<[string, string | undefined]>): ResultadoIntencao {
  const corpo = linhas
    .filter((linha): linha is [string, string] => Boolean(linha[1]))
    .map(([rotulo, valor]) => `• ${rotulo}: ${valor}`)
    .join('\n');

  return {
    perguntar: 'confirmacao',
    pergunta: `Confere se entendi certo antes de registrar:\n\n${corpo}\n\nResponda *sim* pra confirmar, ou corrija um campo (ex: "categoria: combustível").`,
  };
}

async function registrarDespesa(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.valor) return { resposta: 'Quanto foi o valor da despesa?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const categoria = await resolverCategoria(sessao.token, campos.categoria);

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Valor', moeda(campos.valor)],
      ['Categoria', categoria.nome],
      ['Fazenda', fazenda!.nome],
      ['Data', campos.data || hojeISO()],
      ['Descrição', campos.descricao || categoria.nome],
      ['Forma de pagamento', campos.formaPagamento || 'OUTRO'],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const despesa = await backendClient.criarDespesa(sessao.token, {
    fazendaSlug: fazenda!.slug,
    categoriaSlug: categoria.slug,
    descricao: campos.descricao || categoria.nome,
    valor: campos.valor,
    data: campos.data || hojeISO(),
    formaPagamento: campos.formaPagamento || 'OUTRO',
    anexoUrl: campos.anexoUrl,
  });

  return {
    resposta: `Despesa registrada: ${moeda(despesa.valor)} em ${categoria.nome} na fazenda ${fazenda!.nome}. ✅`,
  };
}

async function registrarContaPagar(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.valor) return { resposta: 'Quanto é o valor da conta a pagar?' };
  if (!campos.dataVencimento) return { resposta: 'Pra quando é o vencimento?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Valor', campos.numeroParcelas && campos.numeroParcelas > 1 ? `${moeda(campos.valor)} x${campos.numeroParcelas}` : moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      ['Vencimento (1ª parcela)', campos.dataVencimento],
      ['Descrição', campos.descricao || 'Conta a pagar'],
      ['Fornecedor', campos.fornecedor],
      ['Forma de pagamento', campos.formaPagamento],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const conta = await backendClient.criarContaPagar(sessao.token, {
    fazendaSlug: fazenda!.slug,
    descricao: campos.descricao || 'Conta a pagar',
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    fornecedor: campos.fornecedor,
    formaPagamento: campos.formaPagamento,
    numeroParcelas: campos.numeroParcelas,
  });

  if (conta.totalParcelas > 1) {
    const ultima = conta.proximasParcelas?.[conta.proximasParcelas.length - 1];
    return {
      resposta: `Conta a pagar parcelada registrada: ${conta.totalParcelas}x de ${moeda(conta.valor)} (total ${moeda(conta.valor * conta.totalParcelas)}), 1ª parcela em ${conta.dataVencimento}${ultima ? `, última em ${ultima.dataVencimento}` : ''}. ✅`,
    };
  }

  return { resposta: `Conta a pagar registrada: ${moeda(conta.valor)}, vencimento em ${conta.dataVencimento}. ✅` };
}

async function registrarContaReceber(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.valor) return { resposta: 'Quanto é o valor a receber?' };
  if (!campos.dataVencimento) return { resposta: 'Pra quando é o previsto?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Valor', campos.numeroParcelas && campos.numeroParcelas > 1 ? `${moeda(campos.valor)} x${campos.numeroParcelas}` : moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      ['Previsto (1ª parcela)', campos.dataVencimento],
      ['Descrição', campos.descricao || 'Conta a receber'],
      ['Comprador', campos.comprador],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const conta = await backendClient.criarContaReceber(sessao.token, {
    fazendaSlug: fazenda!.slug,
    descricao: campos.descricao || 'Conta a receber',
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    comprador: campos.comprador,
    numeroParcelas: campos.numeroParcelas,
  });

  if (conta.totalParcelas > 1) {
    const ultima = conta.proximasParcelas?.[conta.proximasParcelas.length - 1];
    return {
      resposta: `Conta a receber parcelada registrada: ${conta.totalParcelas}x de ${moeda(conta.valor)} (total ${moeda(conta.valor * conta.totalParcelas)}), 1ª parcela prevista em ${conta.dataVencimento}${ultima ? `, última em ${ultima.dataVencimento}` : ''}. ✅`,
    };
  }

  return { resposta: `Conta a receber registrada: ${moeda(conta.valor)}, previsto para ${conta.dataVencimento}. ✅` };
}

async function registrarVenda(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.produto) return { resposta: 'O que você vendeu?' };
  if (!campos.quantidade) return { resposta: 'Qual a quantidade vendida?' };
  if (!campos.valor) return { resposta: 'Qual o preço unitário da venda?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const produtoResolvido = await resolverProduto(sessao.token, campos.produto);
  if (produtoResolvido.erro) return { resposta: produtoResolvido.erro };

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Produto', produtoResolvido.produto!.nome],
      ['Quantidade', `${campos.quantidade} ${campos.unidadeMedida || produtoResolvido.produto!.unidadeMedida}`],
      ['Preço unitário', moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      ['Data', campos.data || hojeISO()],
      ['Comprador', campos.comprador],
      ['Já recebeu o pagamento?', campos.gerarContaReceber ? 'Sim' : 'Não'],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const venda = await backendClient.criarVenda(sessao.token, {
    fazendaSlug: fazenda!.slug,
    produtoSlug: produtoResolvido.produto!.slug,
    quantidade: campos.quantidade,
    unidadeMedida: campos.unidadeMedida || produtoResolvido.produto!.unidadeMedida,
    precoUnitario: campos.valor,
    data: campos.data || hojeISO(),
    comprador: campos.comprador,
    gerarContaReceber: Boolean(campos.gerarContaReceber),
  });

  return {
    resposta: `Venda registrada: ${campos.quantidade} ${venda.unidadeMedida} de ${produtoResolvido.produto!.nome} a ${moeda(campos.valor)} = ${moeda(venda.valorTotal)}. ✅`,
  };
}

async function consultarResumo(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
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

async function consultarContasPagar(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const contas = await backendClient.listarContasPagar(sessao.token, { status: 'PENDENTE' });
  const lista = Array.isArray(contas) ? contas : contas.dados || [];

  if (lista.length === 0) return { resposta: 'Você não tem nenhuma conta a pagar pendente. 🎉' };

  const linhas = lista
    .slice(0, 10)
    .map((c: any) => `• ${c.descricao} — ${moeda(c.valor)} (vence ${c.dataVencimento}, status ${c.statusConta})`);

  return { resposta: `Suas contas a pagar:\n${linhas.join('\n')}` };
}

async function consultarPrecosMercado(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const precos = await backendClient.getPrecosMercado(sessao.token, fazenda!.slug);

  if (precos.length === 0) {
    return { resposta: 'Ainda não tenho cotações para as culturas da sua fazenda. Tente novamente mais tarde.' };
  }

  const linhas = precos.map((p: any) => `• ${p.cultura}: ${moeda(p.preco)} (${p.unidade}) em ${p.praca}/${p.estado} — ${p.data}`);
  return { resposta: `Últimas cotações (${fazenda!.nome}):\n${linhas.join('\n')}` };
}

const HANDLERS: Record<string, (sessao: SessaoWhatsapp, campos: CamposExtraidos) => Promise<ResultadoIntencao>> = {
  REGISTRAR_DESPESA: registrarDespesa,
  REGISTRAR_CONTA_PAGAR: registrarContaPagar,
  REGISTRAR_CONTA_RECEBER: registrarContaReceber,
  REGISTRAR_VENDA: registrarVenda,
  CONSULTAR_RESUMO: consultarResumo,
  CONSULTAR_CONTAS_PAGAR: consultarContasPagar,
  CONSULTAR_PRECOS_MERCADO: consultarPrecosMercado,
  SAUDACAO: saudacao,
};

// Executa o handler da intenção. Intenções sem handler (AJUDA, NAO_ENTENDI) usam diretamente o
// campo `resposta` que a própria IA já preencheu.
// Erros de chamada ao backend-safraplan propagam de propósito — quem decide se tenta de novo
// (ex: token expirado) ou desiste é o orquestrador (conversation.js).
export async function tratarIntencao(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const handler = HANDLERS[campos.intent];

  if (!handler) {
    return { resposta: campos.resposta || 'Não entendi, pode reformular?' };
  }

  return handler(sessao, campos);
}
