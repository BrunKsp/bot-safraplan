// Histórico de mensagens por número de WhatsApp — usado como contexto para a IA.

import { AppDataSource } from '../database/data-source';
import { Mensagem, PapelMensagem } from '../database/entities/Mensagem';

const HISTORY_LIMIT = 8;

const repo = () => AppDataSource.getRepository(Mensagem);

export interface MensagemHistorico {
  role: PapelMensagem;
  content: string;
}

export interface MensagemHistoricoCompleto extends MensagemHistorico {
  id: string;
  criadoEm: Date;
}

export async function getRecentHistory(celular: string): Promise<MensagemHistorico[]> {
  const linhas = await repo().find({
    where: { celular },
    order: { criadoEm: 'DESC' },
    take: HISTORY_LIMIT,
  });

  return linhas.reverse().map((linha) => ({ role: linha.role, content: linha.content }));
}

// Histórico completo (com id/timestamp) para exibir no front-end — não usado como contexto da
// IA (isso é getRecentHistory, com limite curto), só para renderizar a conversa na tela.
export async function getHistorico(celular: string, limit = 50): Promise<MensagemHistoricoCompleto[]> {
  const linhas = await repo().find({
    where: { celular },
    order: { criadoEm: 'DESC' },
    take: Math.min(limit, 200),
  });

  return linhas.reverse().map((linha) => ({
    id: linha.id,
    role: linha.role,
    content: linha.content,
    criadoEm: linha.criadoEm,
  }));
}

export async function salvarMensagem(celular: string, role: PapelMensagem, content: string): Promise<void> {
  await repo().insert({ celular, role, content });
}
