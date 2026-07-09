// Calcula números reais de gastos (totais por categoria, variação mês a mês, contas
// vencendo) a partir do backend-safraplan e pede pra IA transformar isso em frases curtas,
// no estilo do card "Insights do Plano" — a IA nunca inventa os números, só formata.
const backendClient = require('./backendClient');
const { gerarInsights } = require('./ai');

const PAGE_SIZE = 100;

function paraISO(data) {
  return data.toISOString().slice(0, 10);
}

function limitesDoMes() {
  const hoje = new Date();
  const inicioMesAtual = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
  const fimMesAnterior = new Date(inicioMesAtual.getTime() - 24 * 60 * 60 * 1000);
  const inicioMesAnterior = new Date(Date.UTC(fimMesAnterior.getUTCFullYear(), fimMesAnterior.getUTCMonth(), 1));

  return {
    inicioMesAtual: paraISO(inicioMesAtual),
    fimMesAtual: paraISO(hoje),
    inicioMesAnterior: paraISO(inicioMesAnterior),
    fimMesAnterior: paraISO(fimMesAnterior),
  };
}

async function buscarTodasDespesas(token, params) {
  const despesas = [];
  let page = 1;

  while (true) {
    const resultado = await backendClient.listarDespesas(token, { ...params, page, limit: PAGE_SIZE });
    despesas.push(...resultado.dados);
    if (page >= resultado.totalPaginas) break;
    page += 1;
  }

  return despesas;
}

function agruparPorCategoria(despesas, nomePorCategoriaId) {
  const totais = new Map();

  for (const despesa of despesas) {
    const nome = nomePorCategoriaId.get(despesa.categoriaId) || 'Outros';
    totais.set(nome, (totais.get(nome) || 0) + Number(despesa.valor));
  }

  return totais;
}

async function gerarInsightsDoMes(sessao) {
  const { token } = sessao;
  const { inicioMesAtual, fimMesAtual, inicioMesAnterior, fimMesAnterior } = limitesDoMes();

  const [categorias, despesasMesAtual, despesasMesAnterior, contasVencendo] = await Promise.all([
    backendClient.listarCategorias(token),
    buscarTodasDespesas(token, { dataInicio: inicioMesAtual, dataFim: fimMesAtual }),
    buscarTodasDespesas(token, { dataInicio: inicioMesAnterior, dataFim: fimMesAnterior }),
    backendClient.listarContasPagar(token, { vencendoEm: 7 }),
  ]);

  const nomePorCategoriaId = new Map(categorias.map((categoria) => [categoria.id, categoria.nome]));
  const totaisMesAtual = agruparPorCategoria(despesasMesAtual, nomePorCategoriaId);
  const totaisMesAnterior = agruparPorCategoria(despesasMesAnterior, nomePorCategoriaId);
  const totalGeralMesAtual = [...totaisMesAtual.values()].reduce((soma, valor) => soma + valor, 0);

  const categoriasResumo = [...totaisMesAtual.entries()]
    .map(([categoria, totalMesAtual]) => {
      const totalMesAnterior = totaisMesAnterior.get(categoria) || 0;
      const variacaoPercentual = totalMesAnterior > 0
        ? Math.round(((totalMesAtual - totalMesAnterior) / totalMesAnterior) * 100)
        : null;
      const participacaoPercentual = totalGeralMesAtual > 0
        ? Math.round((totalMesAtual / totalGeralMesAtual) * 100)
        : 0;

      return { categoria, totalMesAtual, totalMesAnterior, variacaoPercentual, participacaoPercentual };
    })
    .sort((a, b) => b.totalMesAtual - a.totalMesAtual);

  const resumo = {
    periodo: { inicioMesAtual, fimMesAtual },
    totalGeralMesAtual,
    categorias: categoriasResumo,
    contasVencendoProximos7Dias: contasVencendo.length,
  };

  if (categoriasResumo.length === 0) {
    return { insights: ['Ainda não há despesas registradas neste mês para gerar insights.'], resumo };
  }

  const { insights } = await gerarInsights(resumo);
  return { insights, resumo };
}

module.exports = { gerarInsightsDoMes };
