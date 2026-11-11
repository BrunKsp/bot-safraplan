// Um handler por intenção: recebe a sessão (vínculo do celular com o cliente) e os campos
// extraídos pela IA, chama o backend-safraplan e devolve a resposta formatada para o WhatsApp.
//
// Quando falta uma informação (ex: qual fazenda), o handler retorna `perguntar` em vez de
// `resposta` — o orquestrador (conversation.js) salva isso como contexto pendente e, na próxima
// mensagem, reinvoca o mesmo handler com o campo preenchido.

import * as backendClient from '../services/backendClient';
import * as session from '../services/session';
import { resolverFazenda, resolverCategoria, resolverProduto, normalizar } from './resolvers';
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
  const itens = (campos.itensDespesa ?? []).filter((item) =>
    item.descricao?.trim() && Number.isFinite(item.valor) && item.valor > 0,
  );

  if (itens.length > 0) {
    const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
    if (resposta) return { resposta };
    if (perguntar) return { perguntar, pergunta };

    campos.data = campos.data || hojeISO();
    campos.formaPagamento = campos.formaPagamento || 'OUTRO';
    const total = itens.reduce((soma, item) => soma + item.valor, 0);

    if (!campos.confirmado) {
      const linhas: Array<[string, string | undefined]> = [
        ['Fazenda', fazenda!.nome],
        ['Data padrão', campos.data],
        ['Lançamentos', `${itens.length} despesas — total ${moeda(total)}`],
        ...itens.slice(0, 15).map((item) => ['Item', `${item.descricao}: ${moeda(item.valor)}`] as [string, string]),
      ];
      if (itens.length > 15) linhas.push(['Itens restantes', `e mais ${itens.length - 15}`]);
      return pedirConfirmacao(linhas);
    }

    await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);
    const despesas = [];
    for (const item of itens) {
      const categoria = await resolverCategoria(sessao.token, item.categoria || campos.categoria);
      despesas.push(await backendClient.criarDespesa(sessao.token, {
        fazendaSlug: fazenda!.slug,
        categoriaSlug: categoria.slug,
        descricao: item.descricao.trim(),
        valor: item.valor,
        data: item.data || campos.data,
        formaPagamento: item.formaPagamento || campos.formaPagamento,
        anexoUrl: campos.anexoUrl,
      }));
    }

    return { resposta: `${despesas.length} despesas registradas, total de ${moeda(total)}, na fazenda ${fazenda!.nome}. ✅` };
  }

  if (!campos.valor) return { resposta: 'Quanto foi o valor da despesa?' };

  // Compra parcelada = os dois lançamentos: a despesa em si com o valor bruto (categorização,
  // histórico) MAIS as parcelas como conta a pagar (controle de fluxo de caixa). A despesa
  // sozinha não tem conceito de parcela — quem carrega isso é a conta a pagar gerada junto.
  const parcelado = Boolean(campos.numeroParcelas && campos.numeroParcelas > 1);
  if (parcelado && !campos.dataVencimento && !campos.data) {
    return { resposta: 'Pra quando é a 1ª parcela?' };
  }

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const categoria = await resolverCategoria(sessao.token, campos.categoria);

  // Aplica os valores padrão DIRETO no objeto `campos` (em vez de só na hora de montar o texto
  // de confirmação) — esse mesmo objeto é o que fica salvo em contexto_pendente e reaproveitado
  // quando o produtor responde "sim". Sem isso, o resumo mostrado podia divergir do que de fato
  // é gravado no backend, se por qualquer motivo o valor "cru" (sem fallback) se perder no meio
  // do caminho entre as duas mensagens.
  campos.data = campos.data || hojeISO();
  campos.formaPagamento = campos.formaPagamento || 'OUTRO';
  campos.descricao = campos.descricao || categoria.nome;
  const dataPrimeiraParcela = campos.dataVencimento || campos.data;
  const valorParcela = parcelado ? Math.round((campos.valor / campos.numeroParcelas!) * 100) / 100 : campos.valor;

  if (!campos.confirmado) {
    const linhas: Array<[string, string | undefined]> = [
      ['Valor total (despesa)', moeda(campos.valor)],
      ['Categoria', categoria.nome],
      ['Fazenda', fazenda!.nome],
      ['Data', campos.data],
      ['Descrição', campos.descricao],
      ['Forma de pagamento', campos.formaPagamento],
    ];
    if (parcelado) {
      linhas.push(['Parcelamento (conta a pagar)', `${campos.numeroParcelas}x de ${moeda(valorParcela)}, 1ª em ${dataPrimeiraParcela}`]);
    }
    return pedirConfirmacao(linhas);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const despesa = await backendClient.criarDespesa(sessao.token, {
    fazendaSlug: fazenda!.slug,
    categoriaSlug: categoria.slug,
    descricao: campos.descricao,
    valor: campos.valor,
    data: campos.data,
    formaPagamento: campos.formaPagamento,
    anexoUrl: campos.anexoUrl,
  });

  const respostaDespesa = `Despesa registrada: ${moeda(despesa.valor)} em ${categoria.nome} na fazenda ${fazenda!.nome}. ✅`;

  // Sugestões contextuais pós-registro
  let sugestao = '';
  const catNorm = normalizar(categoria.nome);
  if (catNorm.includes('manutencao') || catNorm.includes('reparo') || catNorm.includes('oficina')) {
    const maquinas = await backendClient.listarMaquinas(sessao.token).catch(() => []);
    if (maquinas.length > 0) {
      sugestao = '\n\n💡 Quer vincular essa manutenção a uma máquina? Me diga *registrar manutenção* com o nome dela.';
    } else {
      sugestao = '\n\n💡 Você tem máquinas? Me diga *cadastrar máquina* e controlo a depreciação pra você.';
    }
  } else if (catNorm.includes('combustivel') || catNorm.includes('diesel') || catNorm.includes('gasolina')) {
    const maquinas = await backendClient.listarMaquinas(sessao.token).catch(() => []);
    if (maquinas.length === 0) {
      sugestao = '\n\n💡 Quer cadastrar suas máquinas? Assim consigo calcular o custo de combustível por equipamento.';
    }
  } else if (catNorm.includes('arrendamento') || catNorm.includes('aluguel') || catNorm.includes('arrendamento')) {
    const arrendamentos = await backendClient.listarArrendamentos(sessao.token).catch(() => []);
    if (arrendamentos.length === 0) {
      sugestao = '\n\n💡 Quer cadastrar esse arrendamento? Assim o sistema controla as parcelas automaticamente. Me diga *cadastrar arrendamento*.';
    }
  }

  if (!parcelado) return { resposta: respostaDespesa + sugestao };

  const conta = await backendClient.criarContaPagar(sessao.token, {
    fazendaSlug: fazenda!.slug,
    categoriaSlug: categoria.slug,
    descricao: `${campos.descricao} (parcelamento)`,
    valor: valorParcela,
    dataVencimento: dataPrimeiraParcela,
    formaPagamento: campos.formaPagamento,
    numeroParcelas: campos.numeroParcelas,
  });

  const ultima = conta.proximasParcelas?.[conta.proximasParcelas.length - 1];
  return {
    resposta: `${respostaDespesa}\nParcelas geradas como conta a pagar: ${conta.totalParcelas}x de ${moeda(conta.valor)}, 1ª em ${conta.dataVencimento}${ultima ? `, última em ${ultima.dataVencimento}` : ''}.${sugestao}`,
  };
}

async function registrarContaPagar(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.valor) return { resposta: 'Quanto é o valor da conta a pagar?' };
  if (!campos.dataVencimento) return { resposta: 'Pra quando é o vencimento?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  campos.descricao = campos.descricao || 'Conta a pagar';

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Valor', campos.numeroParcelas && campos.numeroParcelas > 1 ? `${moeda(campos.valor)} x${campos.numeroParcelas}` : moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      ['Vencimento (1ª parcela)', campos.dataVencimento],
      ['Descrição', campos.descricao],
      ['Fornecedor', campos.fornecedor],
      ['Forma de pagamento', campos.formaPagamento],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const conta = await backendClient.criarContaPagar(sessao.token, {
    fazendaSlug: fazenda!.slug,
    descricao: campos.descricao,
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    fornecedor: campos.fornecedor,
    formaPagamento: campos.formaPagamento,
    numeroParcelas: campos.numeroParcelas,
  });

  // Sugestão: se parecer arrendamento, sugere cadastrar formalmente
  let sugestaoArrendamento = '';
  const descNorm = normalizar(campos.descricao);
  if (descNorm.includes('arrendamento') || descNorm.includes('aluguel terra') || descNorm.includes('arrendamento')) {
    const arrendamentos = await backendClient.listarArrendamentos(sessao.token).catch(() => []);
    if (arrendamentos.length === 0) {
      sugestaoArrendamento = '\n\n💡 Quer cadastrar esse arrendamento formalmente? Assim o sistema gera as parcelas automaticamente. Me diga *cadastrar arrendamento*.';
    }
  }

  if (conta.totalParcelas > 1) {
    const ultima = conta.proximasParcelas?.[conta.proximasParcelas.length - 1];
    return {
      resposta: `Conta a pagar parcelada registrada: ${conta.totalParcelas}x de ${moeda(conta.valor)} (total ${moeda(conta.valor * conta.totalParcelas)}), 1ª parcela em ${conta.dataVencimento}${ultima ? `, última em ${ultima.dataVencimento}` : ''}. ✅${sugestaoArrendamento}`,
    };
  }

  return { resposta: `Conta a pagar registrada: ${moeda(conta.valor)}, vencimento em ${conta.dataVencimento}. ✅${sugestaoArrendamento}` };
}

async function registrarContaReceber(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.valor) return { resposta: 'Quanto é o valor a receber?' };

  // "Entrada de X" / "recebi X" = dinheiro que já caiu, não uma previsão futura — não faz sentido
  // pedir "pra quando é o previsto?" nesse caso, já assume hoje se não disser outra data.
  const jaRecebido = Boolean(campos.jaRecebido);
  if (!jaRecebido && !campos.dataVencimento) return { resposta: 'Pra quando é o previsto?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  campos.descricao = campos.descricao || 'Conta a receber';
  if (jaRecebido) {
    campos.data = campos.data || hojeISO();
    campos.dataVencimento = campos.dataVencimento || campos.data;
  }

  if (!campos.confirmado) {
    const linhas: Array<[string, string | undefined]> = [
      ['Valor', campos.numeroParcelas && campos.numeroParcelas > 1 ? `${moeda(campos.valor)} x${campos.numeroParcelas}` : moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      [jaRecebido ? 'Data do recebimento' : 'Previsto (1ª parcela)', jaRecebido ? campos.data : campos.dataVencimento],
      ['Descrição', campos.descricao],
      ['Comprador', campos.comprador],
    ];
    if (jaRecebido) linhas.push(['Status', 'Já recebido']);
    return pedirConfirmacao(linhas);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const conta = await backendClient.criarContaReceber(sessao.token, {
    fazendaSlug: fazenda!.slug,
    descricao: campos.descricao,
    valor: campos.valor,
    dataVencimento: campos.dataVencimento,
    comprador: campos.comprador,
    numeroParcelas: campos.numeroParcelas,
  });

  if (jaRecebido) {
    const recebida = await backendClient.receberContaReceber(sessao.token, conta.slug, {
      dataRecebimento: campos.data,
    });
    return { resposta: `Entrada registrada: ${moeda(recebida.valor)} recebidos em ${recebida.dataRecebimento} (${recebida.descricao}). ✅` };
  }

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

  campos.data = campos.data || hojeISO();
  campos.unidadeMedida = campos.unidadeMedida || (produtoResolvido.produto!.unidadeMedida as CamposExtraidos['unidadeMedida']);

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Produto', produtoResolvido.produto!.nome],
      ['Quantidade', `${campos.quantidade} ${campos.unidadeMedida}`],
      ['Preço unitário', moeda(campos.valor)],
      ['Fazenda', fazenda!.nome],
      ['Data', campos.data],
      ['Comprador', campos.comprador],
      ['Já recebeu o pagamento?', campos.gerarContaReceber ? 'Sim' : 'Não'],
    ]);
  }

  await session.salvarFazendaPadrao(sessao.celular, fazenda!.slug);

  const venda = await backendClient.criarVenda(sessao.token, {
    fazendaSlug: fazenda!.slug,
    produtoSlug: produtoResolvido.produto!.slug,
    quantidade: campos.quantidade,
    unidadeMedida: campos.unidadeMedida,
    precoUnitario: campos.valor,
    data: campos.data,
    comprador: campos.comprador,
    gerarContaReceber: Boolean(campos.gerarContaReceber),
  });

  // Sugestão pós-venda: se produto pecuário e não tem safra, sugere criar
  let sugestaoSafra = '';
  const prodNorm = normalizar(produtoResolvido.produto!.nome);
  if (prodNorm.includes('boi') || prodNorm.includes('gado') || prodNorm.includes('cordeiro') || prodNorm.includes('suino') || prodNorm.includes('bufalo')) {
    const safras = await backendClient.listarSafras(sessao.token, fazenda!.slug).catch(() => []);
    if (safras.length === 0) {
      sugestaoSafra = '\n\n💡 Quer registrar a área de pecuária como uma atividade? Assim calculo a rentabilidade por hectare. Me diga *cadastrar safra* com a cultura e a área.';
    }
  }

  return {
    resposta: `Venda registrada: ${campos.quantidade} ${venda.unidadeMedida} de ${produtoResolvido.produto!.nome} a ${moeda(campos.valor)} = ${moeda(venda.valorTotal)}. ✅${sugestaoSafra}`,
  };
}

const ORDINAIS: Record<string, number> = {
  primeira: 1, '1a': 1, '1ª': 1,
  segunda: 2, '2a': 2, '2ª': 2,
  terceira: 3, '3a': 3, '3ª': 3,
  quarta: 4, '4a': 4, '4ª': 4,
  quinta: 5, '5a': 5, '5ª': 5,
};

// Extrai "1ª/primeira parcela" etc do texto de busca — usado pra distinguir entre parcelas de um
// mesmo parcelamento (todas têm descrição parecida, só o número da parcela muda).
function extrairOrdinalParcela(texto: string): number | null {
  const normalizado = normalizar(texto);
  for (const [palavra, numero] of Object.entries(ORDINAIS)) {
    if (normalizado.includes(palavra)) return numero;
  }
  const match = normalizado.match(/(\d+)\s*(?:a|ª)?\s*parcela/);
  return match ? Number(match[1]) : null;
}

// Marca uma conta a pagar já existente como paga — busca por texto livre (e, se mencionado, pelo
// número da parcela) entre as contas pendentes do cliente, em vez de pedir o slug exato.
async function marcarContaPaga(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.descricao) return { resposta: 'Qual conta você quer marcar como paga? Me diga como reconhecer ela (ex: "primeira parcela das sementes", "conta do fornecedor X").' };

  const contas = await backendClient.listarContasPagar(sessao.token, { status: 'PENDENTE' });
  const lista: any[] = Array.isArray(contas) ? contas : contas.dados || [];

  const ordinal = extrairOrdinalParcela(campos.descricao);
  const termoLimpo = normalizar(campos.descricao)
    .replace(/\b(primeira|segunda|terceira|quarta|quinta|\d+\s*[aª]?)\b/g, '')
    .replace(/parcela/g, '')
    .trim();

  let candidatas = lista;
  if (ordinal) candidatas = candidatas.filter((c) => c.numeroParcela === ordinal);
  if (termoLimpo) {
    const porTexto = candidatas.filter((c) => normalizar(c.descricao).includes(termoLimpo));
    if (porTexto.length > 0) candidatas = porTexto;
  }

  if (candidatas.length === 0) {
    return { resposta: `Não encontrei nenhuma conta a pagar pendente parecida com "${campos.descricao}". Digite *contas a pagar* pra ver a lista.` };
  }

  if (candidatas.length > 1) {
    const linhas = candidatas.slice(0, 10).map((c) => `• ${c.descricao} — ${moeda(c.valor)} (vence ${c.dataVencimento})`);
    return { resposta: `Achei mais de uma conta parecida — me diga mais detalhes pra eu saber qual:\n${linhas.join('\n')}` };
  }

  const conta = candidatas[0];
  campos.data = campos.data || hojeISO();
  campos.formaPagamento = campos.formaPagamento || 'OUTRO';

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Conta', conta.descricao],
      ['Valor', moeda(conta.valor)],
      ['Vencimento', conta.dataVencimento],
      ['Data do pagamento', campos.data],
      ['Forma de pagamento', campos.formaPagamento],
    ]);
  }

  const atualizada = await backendClient.pagarContaPagar(sessao.token, conta.slug, {
    dataPagamento: campos.data,
    formaPagamento: campos.formaPagamento,
  });

  return { resposta: `Conta marcada como paga: ${atualizada.descricao} — ${moeda(atualizada.valor)}. ✅` };
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

async function consultarMediaGastos(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const hoje = new Date()
  const meses: { label: string; inicio: string; fim: string }[] = []

  for (let i = 5; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
    const ano = d.getFullYear()
    const mes = d.getMonth() + 1
    const mm = String(mes).padStart(2, '0')
    const ultimoDia = new Date(ano, mes, 0).getDate()
    const nomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']
    meses.push({ label: `${nomes[mes - 1]}/${ano}`, inicio: `${ano}-${mm}-01`, fim: `${ano}-${mm}-${ultimoDia}` })
  }

  const totais: number[] = []
  const linhasMeses: string[] = []

  for (const m of meses) {
    const despesas = await backendClient.listarDespesas(sessao.token, { dataInicio: m.inicio, dataFim: m.fim, limit: 1000 })
    const lista: any[] = Array.isArray(despesas) ? despesas : despesas.dados ?? []
    const total = lista.reduce((acc: number, d: any) => acc + (Number(d.valor) || 0), 0)
    if (total > 0) {
      totais.push(total)
      linhasMeses.push(`• ${m.label}: ${moeda(total)}`)
    }
  }

  if (totais.length === 0) {
    return { resposta: 'Não encontrei despesas registradas nos últimos 6 meses para calcular uma média.' }
  }

  const media = totais.reduce((a, b) => a + b, 0) / totais.length
  const maior = Math.max(...totais)
  const menor = Math.min(...totais)

  return {
    resposta: [
      `📊 *Média mensal de gastos (últimos ${totais.length} meses)*`,
      `Média: *${moeda(media)}*`,
      `Maior mês: ${moeda(maior)} · Menor: ${moeda(menor)}`,
      '',
      ...linhasMeses,
    ].join('\n'),
  }
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

async function cadastrarAlertaPreco(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.cultura) return { perguntar: 'cultura', pergunta: 'Qual cultura você quer monitorar? (ex: soja, milho, trigo)' };
  if (!campos.precoAlvo) return { perguntar: 'precoAlvo', pergunta: `Qual o preço-alvo para ${campos.cultura}? (ex: 148)` };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const condicao = campos.condicaoAlerta ?? 'ACIMA';

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Cultura', campos.cultura.toUpperCase()],
      ['Preço-alvo', moeda(campos.precoAlvo)],
      ['Condição', condicao === 'ACIMA' ? 'Notificar quando passar acima' : 'Notificar quando cair abaixo'],
      ['Fazenda', fazenda!.nome],
    ]);
  }

  await backendClient.criarAlertaPreco(sessao.token, {
    fazendaSlug: fazenda!.slug,
    cultura: campos.cultura,
    precoAlvo: campos.precoAlvo,
    condicao,
  });

  const direcao = condicao === 'ACIMA' ? 'superar' : 'cair abaixo de';
  return { resposta: `Alerta criado! Vou te avisar quando o preço de ${campos.cultura.toUpperCase()} ${direcao} ${moeda(campos.precoAlvo)}.` };
}

async function listarAlertasPreco(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const alertas = await backendClient.listarAlertasPreco(sessao.token);

  if (alertas.length === 0) {
    return { resposta: 'Você não tem nenhum alerta de preço configurado. Me diz uma cultura e o preço-alvo que eu crio pra você!' };
  }

  const linhas = alertas.map((a: any) => {
    const direcao = a.condicao === 'ACIMA' ? '↑ acima de' : '↓ abaixo de';
    const cotacao = a.cotacaoAtual ? ` | cotação atual: ${moeda(a.cotacaoAtual.preco)}` : '';
    const status = a.disparado ? ' ✅ disparado' : '';
    return `• ${a.cultura} ${direcao} ${moeda(a.precoAlvo)} (${a.fazenda.nome})${cotacao}${status}`;
  });

  return { resposta: `Seus alertas de preço:\n${linhas.join('\n')}` };
}

async function cancelarAlertaPreco(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const alertas = await backendClient.listarAlertasPreco(sessao.token);

  if (alertas.length === 0) {
    return { resposta: 'Você não tem alertas de preço para cancelar.' };
  }

  // Se mencionou cultura, filtra; senão lista todos para o usuário escolher
  const candidatos = campos.cultura
    ? alertas.filter((a: any) => normalizar(a.cultura).includes(normalizar(campos.cultura!)))
    : alertas;

  if (candidatos.length === 0) {
    const nomes = alertas.map((a: any) => `${a.cultura} (${a.fazenda.nome})`).join(', ');
    return { resposta: `Não encontrei alerta para "${campos.cultura}". Seus alertas: ${nomes}.` };
  }

  if (candidatos.length > 1 && !campos.alertaSlug) {
    const opcoes = candidatos.map((a: any, i: number) => `${i + 1}. ${a.cultura} — ${moeda(a.precoAlvo)} (${a.fazenda.nome})`).join('\n');
    return { perguntar: 'alertaSlug', pergunta: `Qual alerta você quer cancelar?\n${opcoes}\n\nResponda com o número.` };
  }

  let alvo = candidatos[0];
  if (campos.alertaSlug) {
    const idx = parseInt(campos.alertaSlug, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= candidatos.length) {
      alvo = candidatos[idx - 1];
    } else {
      alvo = candidatos.find((a: any) => a.slug === campos.alertaSlug) ?? candidatos[0];
    }
  }

  await backendClient.deletarAlertaPreco(sessao.token, alvo.slug);
  return { resposta: `Alerta de ${alvo.cultura} (${moeda(alvo.precoAlvo)}) cancelado.` };
}

const TIPOS_MAQUINA: Record<string, string> = {
  TRATOR: 'Trator',
  COLHEITADEIRA: 'Colheitadeira',
  PLANTADEIRA: 'Plantadeira',
  PULVERIZADOR: 'Pulverizador',
  IMPLEMENTO: 'Implemento',
  VEICULO: 'Veículo',
  OUTRO: 'Outro',
};

async function cadastrarMaquina(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.maquinaNome) return { perguntar: 'maquinaNome', pergunta: 'Qual o nome ou descrição da máquina? (ex: John Deere 6110J, Colheitadeira S680)' };
  if (!campos.maquinaTipo) return { perguntar: 'maquinaTipo', pergunta: 'Qual o tipo? Responda: TRATOR, COLHEITADEIRA, PLANTADEIRA, PULVERIZADOR, IMPLEMENTO, VEICULO ou OUTRO' };
  if (!campos.maquinaValorAquisicao) return { perguntar: 'maquinaValorAquisicao', pergunta: 'Qual foi o valor de aquisição da máquina? (em reais)' };
  if (!campos.maquinaDataAquisicao) return { perguntar: 'maquinaDataAquisicao', pergunta: 'Em que data foi adquirida? (ex: 2023-01-15)' };
  if (!campos.maquinaVidaUtilAnos) return { perguntar: 'maquinaVidaUtilAnos', pergunta: 'Qual a vida útil estimada em anos? (ex: 10)' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Nome', campos.maquinaNome],
      ['Tipo', TIPOS_MAQUINA[campos.maquinaTipo] ?? campos.maquinaTipo],
      ['Marca', campos.maquinaMarca],
      ['Modelo', campos.maquinaModelo],
      ['Ano de fabricação', campos.maquinaAnoFabricacao?.toString()],
      ['Valor de aquisição', moeda(campos.maquinaValorAquisicao)],
      ['Data de aquisição', campos.maquinaDataAquisicao],
      ['Vida útil', `${campos.maquinaVidaUtilAnos} anos`],
      ['Valor residual', campos.maquinaValorResidual ? moeda(campos.maquinaValorResidual) : undefined],
      ['Fazenda', fazenda!.nome],
    ]);
  }

  await backendClient.criarMaquina(sessao.token, {
    fazendaSlug: fazenda!.slug,
    nome: campos.maquinaNome,
    tipo: campos.maquinaTipo,
    marca: campos.maquinaMarca,
    modelo: campos.maquinaModelo,
    anoFabricacao: campos.maquinaAnoFabricacao,
    valorAquisicao: campos.maquinaValorAquisicao,
    dataAquisicao: campos.maquinaDataAquisicao,
    vidaUtilAnos: campos.maquinaVidaUtilAnos,
    valorResidual: campos.maquinaValorResidual ?? 0,
  });

  return { resposta: `Máquina *${campos.maquinaNome}* cadastrada com sucesso! 🚜\nVida útil de ${campos.maquinaVidaUtilAnos} anos a partir de ${campos.maquinaDataAquisicao}.` };
}

async function registrarManutencaoMaquina(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.manutencaoTipo && !campos.descricao) return { perguntar: 'manutencaoTipo', pergunta: 'Que tipo de manutenção foi feita? (ex: troca de óleo, revisão, reparo de motor)' };
  if (!campos.valor) return { resposta: 'Qual foi o custo da manutenção?' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const maquinas = await backendClient.listarMaquinas(sessao.token);
  const maquinasFazenda = maquinas.filter((m: any) => !m.fazenda || m.fazenda.slug === fazenda!.slug);

  let maquina: any = null;
  if (campos.maquinaIdentificacao && maquinasFazenda.length > 0) {
    const termo = normalizar(campos.maquinaIdentificacao);
    maquina = maquinasFazenda.find((m: any) =>
      normalizar(m.nome).includes(termo) || normalizar(m.tipo).includes(termo) ||
      (m.marca && normalizar(m.marca).includes(termo)) || (m.modelo && normalizar(m.modelo).includes(termo))
    );
  }
  if (!maquina && maquinasFazenda.length === 1) maquina = maquinasFazenda[0];
  if (!maquina && maquinasFazenda.length > 1) {
    const opcoes = maquinasFazenda.slice(0, 5).map((m: any, i: number) => `${i + 1}. ${m.nome} (${m.tipo})`).join('\n');
    return { perguntar: 'maquinaIdentificacao', pergunta: `Qual máquina recebeu a manutenção?\n${opcoes}\n\nResponda com o número ou o nome.` };
  }
  if (!maquina) {
    return { resposta: 'Nenhuma máquina cadastrada nessa fazenda. Quer cadastrar uma primeiro? Me diga *cadastrar máquina* com o nome e tipo.' };
  }

  campos.data = campos.data || hojeISO();
  const tipoManutencao = campos.manutencaoTipo || campos.descricao || 'Manutenção';

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Máquina', maquina.nome],
      ['Tipo', tipoManutencao],
      ['Custo', moeda(campos.valor)],
      ['Data', campos.data],
      ['Fazenda', fazenda!.nome],
    ]);
  }

  const categoriaManutencao = await resolverCategoria(sessao.token, 'manutenção');

  await backendClient.criarDespesa(sessao.token, {
    fazendaSlug: fazenda!.slug,
    categoriaSlug: categoriaManutencao.slug,
    descricao: `${tipoManutencao} — ${maquina.nome}`,
    valor: campos.valor,
    data: campos.data,
    formaPagamento: campos.formaPagamento || 'OUTRO',
  });

  await backendClient.registrarManutencaoMaquina(sessao.token, maquina.slug, {
    tipo: 'CORRETIVA',
    descricao: tipoManutencao,
    valor: campos.valor,
    data: campos.data,
    horimetro: campos.manutencaoKm,
  });

  return { resposta: `Manutenção registrada: *${tipoManutencao}* no ${maquina.nome} — ${moeda(campos.valor!)}. ✅\nDespesa lançada automaticamente.` };
}

async function cadastrarArrendamento(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.arrendamentoAreaHa) return { perguntar: 'arrendamentoAreaHa', pergunta: 'Quantos hectares são arrendados?' };
  if (!campos.arrendamentoValorPorHectare && !campos.arrendamentoUnidade) return { perguntar: 'arrendamentoValorPorHectare', pergunta: 'Qual o valor por hectare? (ex: R$300/ha ou 12 sacas de soja)' };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const unidade = campos.arrendamentoUnidade ?? 'REAIS';
  const tipo = campos.arrendamentoTipo ?? 'ARRENDATARIO';
  const valorPorHa = campos.arrendamentoValorPorHectare ?? 0;

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Tipo', tipo === 'ARRENDATARIO' ? 'Você paga (arrendatário)' : 'Você recebe (arrendador)'],
      ['Área', `${campos.arrendamentoAreaHa} ha`],
      ['Valor/ha', unidade === 'SACAS' ? `${valorPorHa} sacas` : moeda(valorPorHa)],
      ['Contraparte', campos.arrendamentoLocador],
      ['Fazenda', fazenda!.nome],
    ]);
  }

  const hoje = hojeISO();
  const dataFim = `${Number(hoje.slice(0, 4)) + 1}${hoje.slice(4)}`; // 1 ano padrão

  const payload: Record<string, unknown> = {
    fazendaSlug: fazenda!.slug,
    tipo,
    contraparte: campos.arrendamentoLocador ?? 'Não informado',
    areaHa: campos.arrendamentoAreaHa,
    modalidade: unidade,
    dataInicio: hoje,
    dataFim,
    diaVencimento: 10,
    mesVencimento: 1,
  };
  if (unidade === 'SACAS') {
    payload.sacasPorHa = valorPorHa;
    payload.culturaReferencia = 'SOJA';
  } else {
    payload.valorFixoAnual = valorPorHa * campos.arrendamentoAreaHa!;
  }

  await backendClient.criarArrendamento(sessao.token, payload);

  const valorStr = unidade === 'SACAS' ? `${valorPorHa} sacas/ha` : `${moeda(valorPorHa)}/ha`;
  return {
    resposta: `Arrendamento cadastrado: ${campos.arrendamentoAreaHa} ha na ${fazenda!.nome} a ${valorStr} (${tipo === 'ARRENDATARIO' ? 'você paga' : 'você recebe'}). ✅\nAcesse o app pra ajustar datas e vencimentos se precisar.`,
  };
}

async function cadastrarSafra(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  if (!campos.safraCultura) return { perguntar: 'safraCultura', pergunta: 'Qual é a cultura ou atividade? (ex: soja, milho, boi gordo, cordeiro)' };
  if (!campos.safraAreaHa) return { perguntar: 'safraAreaHa', pergunta: `Quantos hectares de ${campos.safraCultura}?` };

  const { fazenda, perguntar, pergunta, resposta } = await resolverFazendaOuPerguntar(sessao, campos);
  if (resposta) return { resposta };
  if (perguntar) return { perguntar, pergunta };

  const culturaMap: Record<string, string> = {
    soja: 'SOJA', milho: 'MILHO', trigo: 'TRIGO', arroz: 'ARROZ', feijao: 'FEIJAO',
    'boi gordo': 'BOI_GORDO', boi: 'BOI_GORDO', gado: 'BOI_GORDO', pecuaria: 'BOI_GORDO', bovino: 'BOI_GORDO',
    cordeiro: 'CORDEIRO', ovino: 'CORDEIRO', ovinos: 'CORDEIRO',
    suino: 'SUINO', suinos: 'SUINO', porco: 'SUINO',
    bufalo: 'BUFALO', leite: 'LEITE',
  };
  const culturaEnum = culturaMap[normalizar(campos.safraCultura)] ?? campos.safraCultura.toUpperCase().replace(/\s+/g, '_');
  const ano = campos.safraAno ?? new Date().getFullYear().toString();

  if (!campos.confirmado) {
    return pedirConfirmacao([
      ['Cultura', campos.safraCultura],
      ['Área', `${campos.safraAreaHa} ha`],
      ['Ano safra', ano],
      ['Fazenda', fazenda!.nome],
    ]);
  }

  await backendClient.criarSafra(sessao.token, fazenda!.slug, {
    cultura: culturaEnum,
    areaPlantadaHa: campos.safraAreaHa,
    anoSafra: ano,
    statusSafra: 'EM_ANDAMENTO',
  });

  return {
    resposta: `Safra de ${campos.safraCultura} cadastrada: ${campos.safraAreaHa} ha na ${fazenda!.nome} (${ano}). ✅\nAgora registre as despesas e vendas vinculadas a ela pelo app ou aqui mesmo.`,
  };
}

async function consultarMaquinas(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const maquinas = await backendClient.listarMaquinas(sessao.token)
  if (!maquinas.length) return { resposta: 'Nenhuma máquina cadastrada. Me diga *cadastrar máquina* e eu registro pra você.' }

  const linhas = maquinas.map((m: any) => {
    const partes = [m.nome, m.tipo ? `(${m.tipo})` : null, m.marca ?? null, m.anoFabricacao ?? null].filter(Boolean)
    return `• ${partes.join(' · ')}`
  })
  return { resposta: `🚜 *Suas máquinas (${maquinas.length})*\n${linhas.join('\n')}` }
}

async function consultarManutencoes(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const maquinas = await backendClient.listarMaquinas(sessao.token)
  if (!maquinas.length) return { resposta: 'Nenhuma máquina cadastrada.' }

  let alvo: any[] = maquinas
  if (campos.maquinaIdentificacao) {
    const termo = normalizar(campos.maquinaIdentificacao)
    const filtradas = maquinas.filter((m: any) => normalizar(m.nome).includes(termo) || normalizar(m.tipo ?? '').includes(termo))
    if (filtradas.length) alvo = filtradas
  }

  const blocos: string[] = []
  for (const m of alvo.slice(0, 3)) {
    const detalhe = await backendClient.buscarMaquina(sessao.token, m.slug)
    const manutencoes: any[] = detalhe.manutencoes ?? []
    if (!manutencoes.length) {
      blocos.push(`*${m.nome}*: nenhuma manutenção registrada.`)
      continue
    }
    const recentes = manutencoes.slice(-5).reverse()
    const linhas = recentes.map((mn: any) => `  · ${mn.tipo ?? 'Manutenção'} — ${mn.data ?? ''} — ${mn.custo != null ? moeda(mn.custo) : 'sem custo'}`)
    blocos.push(`*${m.nome}*\n${linhas.join('\n')}`)
  }

  return { resposta: `🔧 *Histórico de manutenções*\n\n${blocos.join('\n\n')}` }
}

async function consultarArrendamentos(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const arrendamentos = await backendClient.listarArrendamentos(sessao.token)
  if (!arrendamentos.length) return { resposta: 'Nenhum arrendamento cadastrado. Me diga *cadastrar arrendamento* para registrar.' }

  const linhas = arrendamentos.map((a: any) => {
    const tipo = a.tipo === 'ARRENDADOR' ? 'você recebe' : 'você paga'
    const valor = a.unidade === 'SACAS' ? `${a.valorPorHectare} sacas/ha` : `${moeda(a.valorPorHectare)}/ha`
    const locador = a.locador ? ` · ${a.locador}` : ''
    return `• ${a.fazenda?.nome ?? 'Fazenda'} — ${a.areaHa} ha — ${valor} (${tipo})${locador}`
  })
  return { resposta: `📋 *Arrendamentos (${arrendamentos.length})*\n${linhas.join('\n')}` }
}

async function consultarSafras(sessao: SessaoWhatsapp): Promise<ResultadoIntencao> {
  const fazendas = await backendClient.listarFazendas(sessao.token)
  if (!fazendas.length) return { resposta: 'Nenhuma fazenda cadastrada.' }

  const blocos: string[] = []
  for (const f of fazendas) {
    const safras: any[] = await backendClient.listarSafras(sessao.token, f.slug)
    const ativas = safras.filter((s: any) => s.statusSafra === 'EM_ANDAMENTO' || s.statusSafra === 'PLANEJAMENTO')
    if (!ativas.length) continue
    const linhas = ativas.map((s: any) => {
      const area = s.areaPlantadaHa ? ` · ${s.areaPlantadaHa} ha` : ''
      const status = s.statusSafra === 'EM_ANDAMENTO' ? 'em andamento' : 'planejamento'
      return `  · ${normalizar(s.cultura).replace(/^./, (c: string) => c.toUpperCase()).replace(/_/g, ' ')}${area} (${status})`
    })
    blocos.push(`*${f.nome}*\n${linhas.join('\n')}`)
  }

  if (!blocos.length) return { resposta: 'Nenhuma safra ativa no momento. Me diga *cadastrar safra* para registrar.' }
  return { resposta: `🌾 *Safras ativas*\n\n${blocos.join('\n\n')}` }
}

function resolverPeriodo(periodo: string | undefined, hoje: Date): { dataInicio: string; dataFim: string; label: string } {
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth()
  const nomes = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']

  if (!periodo) {
    const mm = String(mes + 1).padStart(2, '0')
    const ultimoDia = new Date(ano, mes + 1, 0).getDate()
    return { dataInicio: `${ano}-${mm}-01`, dataFim: `${ano}-${mm}-${ultimoDia}`, label: `${nomes[mes]}/${ano}` }
  }

  const p = normalizar(periodo)

  // "último trimestre" / "trimestre"
  if (p.includes('trimestre')) {
    const d = new Date(ano, mes - 2, 1)
    return { dataInicio: d.toISOString().slice(0, 10), dataFim: hoje.toISOString().slice(0, 10), label: 'últimos 3 meses' }
  }
  // "semana" / "última semana"
  if (p.includes('semana')) {
    const d = new Date(hoje); d.setDate(d.getDate() - 7)
    return { dataInicio: d.toISOString().slice(0, 10), dataFim: hoje.toISOString().slice(0, 10), label: 'última semana' }
  }
  // "este ano" / ano com 4 dígitos
  const anoMatch = p.match(/\b(20\d{2})\b/)
  if (anoMatch || p.includes('ano')) {
    const a = anoMatch ? parseInt(anoMatch[1]) : ano
    return { dataInicio: `${a}-01-01`, dataFim: `${a}-12-31`, label: String(a) }
  }
  // nome do mês
  for (let i = 0; i < nomes.length; i++) {
    if (p.includes(nomes[i])) {
      const mm = String(i + 1).padStart(2, '0')
      const a = i > mes ? ano - 1 : ano
      const ultimoDia = new Date(a, i + 1, 0).getDate()
      return { dataInicio: `${a}-${mm}-01`, dataFim: `${a}-${mm}-${ultimoDia}`, label: `${nomes[i]}/${a}` }
    }
  }

  // fallback: mês atual
  const mm = String(mes + 1).padStart(2, '0')
  const ultimoDia = new Date(ano, mes + 1, 0).getDate()
  return { dataInicio: `${ano}-${mm}-01`, dataFim: `${ano}-${mm}-${ultimoDia}`, label: `${nomes[mes]}/${ano}` }
}

async function consultarDespesas(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const { dataInicio, dataFim, label } = resolverPeriodo(campos.consultaPeriodo, new Date())
  const params: Record<string, unknown> = { dataInicio, dataFim, limit: 100 }

  let categoriaFiltro = ''
  if (campos.consultaCategoria) {
    const cats = await backendClient.listarCategorias(sessao.token)
    const termo = normalizar(campos.consultaCategoria)
    const cat = cats.find((c: any) => normalizar(c.nome).includes(termo))
    if (cat) { params.categoriaId = cat.id; categoriaFiltro = ` de ${cat.nome}` }
  }

  const resultado = await backendClient.listarDespesas(sessao.token, params)
  const lista: any[] = Array.isArray(resultado) ? resultado : resultado.dados ?? []

  if (!lista.length) return { resposta: `Nenhuma despesa${categoriaFiltro} encontrada em ${label}.` }

  const ordenadas = [...lista].sort((a, b) => Number(b.valor) - Number(a.valor)).slice(0, 10)
  const total = lista.reduce((acc: number, d: any) => acc + Number(d.valor || 0), 0)

  const linhas = ordenadas.map((d: any) => `• ${d.descricao ?? d.categoria?.nome ?? '—'} — ${moeda(Number(d.valor))} (${d.data ?? ''})`)
  return {
    resposta: [
      `💸 *Despesas${categoriaFiltro} — ${label}*`,
      `Total: *${moeda(total)}* (${lista.length} lançamentos)`,
      '',
      ...linhas,
      lista.length > 10 ? `\n_...e mais ${lista.length - 10} lançamentos_` : '',
    ].filter(l => l !== '').join('\n'),
  }
}

async function consultarPrecoUnitario(sessao: SessaoWhatsapp, campos: CamposExtraidos): Promise<ResultadoIntencao> {
  const { consultaQuantidade, consultaTotal, consultaUnidade, consultaDescricao } = campos
  const unidade = consultaUnidade ?? 'unidade'

  // Cálculo direto — tem quantidade e total
  if (consultaQuantidade && consultaTotal) {
    const precoUnitario = consultaTotal / consultaQuantidade
    const desc = consultaDescricao ? ` de ${consultaDescricao}` : ''
    return { resposta: `📐 Cada ${unidade}${desc} ficou *${moeda(precoUnitario)}*\n(${moeda(consultaTotal)} ÷ ${consultaQuantidade} ${unidade}s)` }
  }

  // Busca em despesas passadas
  if (consultaDescricao) {
    const hoje = new Date()
    const tres = new Date(hoje.getFullYear(), hoje.getMonth() - 3, 1)
    const resultado = await backendClient.listarDespesas(sessao.token, {
      dataInicio: tres.toISOString().slice(0, 10),
      dataFim: hoje.toISOString().slice(0, 10),
      limit: 200,
    })
    const lista: any[] = Array.isArray(resultado) ? resultado : resultado.dados ?? []
    const termo = normalizar(consultaDescricao)
    const encontradas = lista.filter((d: any) => normalizar(d.descricao ?? '').includes(termo) || normalizar(d.categoria?.nome ?? '').includes(termo))

    if (!encontradas.length) return { resposta: `Não encontrei nenhuma despesa com "${consultaDescricao}" nos últimos 3 meses.\n\nMe diga o total pago e a quantidade para eu calcular o preço unitário.` }

    const mais = encontradas[0]
    const linhas = [`Última compra de *${consultaDescricao}*:`, `• ${mais.descricao ?? consultaDescricao} — ${moeda(Number(mais.valor))} em ${mais.data ?? ''}`]
    if (encontradas.length > 1) linhas.push(`\n_${encontradas.length - 1} compra(s) anterior(es) encontrada(s)._`)
    linhas.push(`\nSe quiser o preço por ${unidade}, me diga a quantidade total dessa compra.`)
    return { resposta: linhas.join('\n') }
  }

  return { resposta: `Me diz o total pago e a quantidade para eu calcular o preço por ${unidade}.\nEx: "comprei 100 sacos por R$10.000"` }
}

const HANDLERS: Record<string, (sessao: SessaoWhatsapp, campos: CamposExtraidos) => Promise<ResultadoIntencao>> = {
  REGISTRAR_DESPESA: registrarDespesa,
  REGISTRAR_CONTA_PAGAR: registrarContaPagar,
  REGISTRAR_CONTA_RECEBER: registrarContaReceber,
  REGISTRAR_VENDA: registrarVenda,
  MARCAR_CONTA_PAGA: marcarContaPaga,
  CONSULTAR_RESUMO: consultarResumo,
  CONSULTAR_MEDIA_GASTOS: consultarMediaGastos,
  CONSULTAR_CONTAS_PAGAR: consultarContasPagar,
  CONSULTAR_PRECOS_MERCADO: consultarPrecosMercado,
  CADASTRAR_ALERTA_PRECO: cadastrarAlertaPreco,
  LISTAR_ALERTAS_PRECO: listarAlertasPreco,
  CANCELAR_ALERTA_PRECO: cancelarAlertaPreco,
  CADASTRAR_MAQUINA: cadastrarMaquina,
  REGISTRAR_MANUTENCAO_MAQUINA: registrarManutencaoMaquina,
  CADASTRAR_ARRENDAMENTO: cadastrarArrendamento,
  CADASTRAR_SAFRA: cadastrarSafra,
  CONSULTAR_MAQUINAS: consultarMaquinas,
  CONSULTAR_MANUTENCOES: consultarManutencoes,
  CONSULTAR_ARRENDAMENTOS: consultarArrendamentos,
  CONSULTAR_SAFRAS: consultarSafras,
  CONSULTAR_DESPESAS: consultarDespesas,
  CONSULTAR_PRECO_UNITARIO: consultarPrecoUnitario,
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
