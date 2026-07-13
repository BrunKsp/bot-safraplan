// Calcula números reais de gastos (totais por categoria, variação mês a mês, contas
// vencendo) a partir do backend-safraplan e pede pra IA transformar isso em frases curtas,
// no estilo do card "Insights do Plano" — a IA nunca inventa os números, só formata.
import * as backendClient from './backendClient';
import { gerarInsights } from './ai';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

const PAGE_SIZE = 100;

interface CategoriaResumo {
  categoria: string;
  totalMesAtual: number;
  totalMesAnterior: number;
  variacaoPercentual: number | null;
  participacaoPercentual: number;
}

interface Resumo {
  periodo: { inicioMesAtual: string; fimMesAtual: string };
  totalGeralMesAtual: number;
  categorias: CategoriaResumo[];
  contasVencendoProximos7Dias: number;
}

function paraISO(data: Date): string {
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

async function buscarTodasDespesas(token: string, params: Record<string, unknown>): Promise<any[]> {
  const despesas: any[] = [];
  let page = 1;

  while (true) {
    const resultado = await backendClient.listarDespesas(token, { ...params, page, limit: PAGE_SIZE });
    despesas.push(...resultado.dados);
    if (page >= resultado.totalPaginas) break;
    page += 1;
  }

  return despesas;
}

function agruparPorCategoria(despesas: any[], nomePorCategoriaId: Map<string, string>): Map<string, number> {
  const totais = new Map<string, number>();

  for (const despesa of despesas) {
    const nome = nomePorCategoriaId.get(despesa.categoriaId) || 'Outros';
    totais.set(nome, (totais.get(nome) || 0) + Number(despesa.valor));
  }

  return totais;
}

export async function gerarInsightsDoMes(sessao: SessaoWhatsapp): Promise<{ insights: string[]; resumo: Resumo }> {
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

  const categoriasResumo: CategoriaResumo[] = [...totaisMesAtual.entries()]
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

  const resumo: Resumo = {
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
