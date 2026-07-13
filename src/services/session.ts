// Gerencia a sessão de cada número de WhatsApp: o vínculo com o cliente do backend-safraplan
// (token JWT) e o contexto de uma conversa em andamento (ex: bot perguntou "qual fazenda?" e
// está esperando a resposta antes de terminar de registrar uma despesa).

import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../database/data-source';
import { ContextoPendente, SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';
import { loginPorCelular } from './backendClient';
import { decodificarToken } from '../utils/jwt';

const repo = () => AppDataSource.getRepository(SessaoWhatsapp);

// O backend-safraplan omite `id` do objeto `cliente` na resposta de login (mesmo padrão usado
// no login por e-mail/senha) — o clienteId só vem embutido no próprio token JWT (claim `sub`).

export async function buscarSessao(celular: string): Promise<SessaoWhatsapp | null> {
  return repo().findOne({ where: { celular } });
}

// Resolve a sessão só pelo clienteId do token (sem precisar do celular) — usado no /chat quando
// o cliente já mandou mensagem pelo menos uma vez antes (a sessão precisa existir; sem celular
// o bot não tem como autenticar um cliente novo no backend-safraplan).
export async function buscarSessaoPorClienteId(clienteId: string): Promise<SessaoWhatsapp | null> {
  return repo().findOne({ where: { clienteId } });
}

interface DadosSessao {
  clienteId: string;
  clienteSlug: string;
  nome: string | null;
  token: string;
}

export async function criarOuAtualizarSessao(celular: string, dados: DadosSessao): Promise<SessaoWhatsapp> {
  const existente = await buscarSessao(celular);

  const sessao = existente || repo().create({ celular });
  sessao.clienteId = dados.clienteId;
  sessao.clienteSlug = dados.clienteSlug;
  sessao.nome = dados.nome;
  sessao.token = dados.token;
  sessao.tokenCriadoEm = new Date();

  return repo().save(sessao);
}

// Tenta autenticar o número no backend-safraplan (login por celular, sem senha — o WhatsApp
// verificado já é o fator de autenticação) e cria/atualiza a sessão local.
// Retorna null se não existir cliente cadastrado com esse celular.
export async function autenticarCelular(celular: string): Promise<SessaoWhatsapp | null> {
  const resultado = await loginPorCelular(celular);
  if (!resultado) return null;

  const { cliente, token } = resultado;
  const { sub: clienteId } = decodificarToken(token);

  return criarOuAtualizarSessao(celular, {
    clienteId,
    clienteSlug: cliente.slug,
    nome: cliente.nomeCompleto,
    token,
  });
}

export async function salvarFazendaPadrao(celular: string, fazendaSlug: string): Promise<void> {
  await repo().update({ celular }, { fazendaPadraoSlug: fazendaSlug });
}

export async function salvarContextoPendente(celular: string, contexto: ContextoPendente | null): Promise<void> {
  // Cast necessário: o TypeORM não infere bem o QueryDeepPartialEntity de uma coluna jsonb
  // tipada com index signature (ContextoPendente.campos).
  await repo().update({ celular }, { contextoPendente: contexto } as QueryDeepPartialEntity<SessaoWhatsapp>);
}

export async function limparContextoPendente(celular: string): Promise<void> {
  await salvarContextoPendente(celular, null);
}
