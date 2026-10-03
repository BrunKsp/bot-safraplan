// Trata números sem conta no SafraPlan: manda a orientação padrão de cadastro uma única vez e,
// a partir da segunda mensagem, silencia o bot pra esse número — evita ficar respondendo spam/
// robôs de cobrança (Mercado Livre, Claro etc.) que caem no mesmo número conectado à UAZAPI.

import { AppDataSource } from '../database/data-source';
import { NumeroNaoCadastrado } from '../database/entities/NumeroNaoCadastrado';

const repo = () => AppDataSource.getRepository(NumeroNaoCadastrado);

const LINK_CADASTRO = 'https://camposync.com.br';

const MENSAGEM_PADRAO = [
  'Não encontrei nenhuma conta SafraPlan vinculada a este número.',
  `Pra usar o bot, cadastre-se primeiro pelo site: ${LINK_CADASTRO}`,
].join('\n');

// Retorna a mensagem padrão (primeira vez que esse número aparece) ou null (silencia — já foi
// avisado antes e continua sem conta).
export async function tratar(celular: string): Promise<string | null> {
  const existente = await repo().findOne({ where: { celular } });

  if (!existente) {
    await repo().save(repo().create({ celular, mensagensIgnoradas: 0 }));
    return MENSAGEM_PADRAO;
  }

  existente.mensagensIgnoradas += 1;
  await repo().save(existente);
  return null;
}

export async function desbloquear(celular: string): Promise<boolean> {
  const resultado = await repo().delete({ celular });
  return Boolean(resultado.affected);
}

export async function listarBloqueados(): Promise<NumeroNaoCadastrado[]> {
  return repo().find({ order: { criadoEm: 'DESC' } });
}
