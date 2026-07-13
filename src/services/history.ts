// Histórico de mensagens por número de WhatsApp — usado como contexto para a IA.

import { AppDataSource } from '../database/data-source';
import { Mensagem, PapelMensagem } from '../database/entities/Mensagem';

const HISTORY_LIMIT = 8;

const repo = () => AppDataSource.getRepository(Mensagem);

export interface MensagemHistorico {
  role: PapelMensagem;
  content: string;
}

export async function getRecentHistory(celular: string): Promise<MensagemHistorico[]> {
  const linhas = await repo().find({
    where: { celular },
    order: { criadoEm: 'DESC' },
    take: HISTORY_LIMIT,
  });

  return linhas.reverse().map((linha) => ({ role: linha.role, content: linha.content }));
}

export async function salvarMensagem(celular: string, role: PapelMensagem, content: string): Promise<void> {
  await repo().insert({ celular, role, content });
}
