// Onboarding conversacional: quando alguém manda mensagem de um número sem conta no SafraPlan
// (nem sessão local, nem login por celular verificado no backend), em vez de só orientar a
// cadastrar pelo aplicativo, o próprio bot coleta os dados e cria a conta via POST /clientes.

import { AppDataSource } from '../database/data-source';
import { DadosOnboarding, EtapaOnboarding, OnboardingPendente } from '../database/entities/OnboardingPendente';
import * as backendClient from './backendClient';
import * as session from './session';
import { decodificarToken } from '../utils/jwt';

const repo = () => AppDataSource.getRepository(OnboardingPendente);

const ETAPAS: EtapaOnboarding[] = ['nome', 'tipo_documento', 'documento', 'cidade', 'estado', 'email', 'senha'];

const PALAVRAS_CANCELAMENTO = ['cancelar', 'cancela', 'parar', 'sair'];

function pergunta(etapa: EtapaOnboarding, dados: DadosOnboarding): string {
  switch (etapa) {
    case 'nome':
      return 'Qual seu nome completo?';
    case 'tipo_documento':
      return 'Você vai se cadastrar como pessoa física ou empresa? Responda "CPF" ou "CNPJ".';
    case 'documento':
      return `Qual o número do seu ${dados.tipoDocumento}? (só números)`;
    case 'cidade':
      return 'Em qual cidade fica sua fazenda?';
    case 'estado':
      return 'E o estado? (sigla, ex: SP)';
    case 'email':
      return 'Qual seu e-mail?';
    case 'senha':
      return 'Agora crie uma senha (mínimo 8 caracteres, com letra maiúscula, minúscula e número) — pode usá-la também pra entrar pelo aplicativo do SafraPlan.';
  }
}

interface ValidacaoResultado {
  valor?: string;
  erro?: string;
}

function validar(etapa: EtapaOnboarding, textoBruto: string): ValidacaoResultado {
  const texto = textoBruto.trim();

  switch (etapa) {
    case 'nome':
      if (texto.length < 3) return { erro: 'Nome muito curto — qual seu nome completo?' };
      return { valor: texto };

    case 'tipo_documento': {
      const normalizado = texto.toUpperCase().replace(/[^A-Z]/g, '');
      if (normalizado !== 'CPF' && normalizado !== 'CNPJ') {
        return { erro: 'Não entendi — responda apenas "CPF" ou "CNPJ".' };
      }
      return { valor: normalizado };
    }

    case 'documento': {
      const digitos = texto.replace(/\D/g, '');
      if (digitos.length < 11) return { erro: 'Documento inválido — manda só os números, com DDD se for o caso.' };
      return { valor: digitos };
    }

    case 'cidade':
      if (texto.length < 2) return { erro: 'Cidade inválida — qual o nome dela?' };
      return { valor: texto };

    case 'estado': {
      const sigla = texto.toUpperCase().replace(/[^A-Z]/g, '');
      if (sigla.length !== 2) return { erro: 'Informe a sigla do estado, com 2 letras (ex: SP).' };
      return { valor: sigla };
    }

    case 'email':
      if (!/^\S+@\S+\.\S+$/.test(texto)) return { erro: 'E-mail inválido — tenta de novo.' };
      return { valor: texto.toLowerCase() };

    case 'senha':
      if (texto.length < 8) {
        return { erro: 'A senha precisa ter pelo menos 8 caracteres, com letra maiúscula, minúscula e número.' };
      }
      return { valor: texto };
  }
}

function salvarValor(dados: DadosOnboarding, etapa: EtapaOnboarding, valor: string): DadosOnboarding {
  switch (etapa) {
    case 'nome':
      return { ...dados, nomeCompleto: valor };
    case 'tipo_documento':
      return { ...dados, tipoDocumento: valor as 'CPF' | 'CNPJ' };
    case 'documento':
      return { ...dados, documentoValor: valor };
    case 'cidade':
      return { ...dados, cidade: valor };
    case 'estado':
      return { ...dados, estado: valor };
    case 'email':
      return { ...dados, email: valor };
    case 'senha':
      return { ...dados, senha: valor };
  }
}

function proximaEtapa(atual: EtapaOnboarding): EtapaOnboarding | null {
  const indice = ETAPAS.indexOf(atual);
  return ETAPAS[indice + 1] ?? null;
}

function montarPayload(celular: string, dados: DadosOnboarding): Record<string, unknown> {
  const documento = dados.tipoDocumento === 'CNPJ'
    ? { cnpj: dados.documentoValor }
    : { cpf: dados.documentoValor };

  return {
    nomeCompleto: dados.nomeCompleto,
    celular,
    cidade: dados.cidade,
    estado: dados.estado,
    email: dados.email,
    senha: dados.senha,
    ...documento,
  };
}

// A mensagem do bot nunca deve ecoar a senha em texto puro no histórico — quem chama isso decide
// o que persistir em `mensagens`, esse helper só informa se a próxima resposta contém a senha.
export async function buscarEtapaAtual(celular: string): Promise<EtapaOnboarding | null> {
  const registro = await repo().findOne({ where: { celular } });
  return registro?.etapa ?? null;
}

// Primeira mensagem de um número sem conta nenhuma — inicia o cadastro.
export async function iniciar(celular: string): Promise<string> {
  await repo().save(repo().create({ celular, etapa: 'nome', dados: {} }));

  return [
    'Não encontrei nenhuma conta SafraPlan vinculada a este número. Vamos criar uma agora mesmo, rapidinho — a qualquer momento você pode digitar "cancelar" pra parar.',
    '',
    pergunta('nome', {}),
  ].join('\n');
}

async function reiniciarAposErro(celular: string, motivo: string): Promise<string> {
  await repo().save(repo().create({ celular, etapa: 'nome', dados: {} }));
  return `Não consegui criar sua conta: ${motivo}. Vamos tentar de novo — ${pergunta('nome', {})}`;
}

// Processa a resposta do produtor pra etapa atual do cadastro — valida, avança, e no final
// efetivamente cria a conta no backend-safraplan e já autentica a sessão local do bot.
export async function processarResposta(celular: string, texto: string): Promise<string> {
  const registro = await repo().findOne({ where: { celular } });
  if (!registro) return iniciar(celular);

  if (PALAVRAS_CANCELAMENTO.includes(texto.trim().toLowerCase())) {
    await repo().delete({ celular });
    return 'Cadastro cancelado. Se mudar de ideia, é só me mandar outra mensagem que a gente começa de novo. 🌱';
  }

  const resultado = validar(registro.etapa, texto);
  if (resultado.erro) return resultado.erro;

  const dadosAtualizados = salvarValor(registro.dados, registro.etapa, resultado.valor!);
  const proxima = proximaEtapa(registro.etapa);

  if (proxima) {
    registro.dados = dadosAtualizados;
    registro.etapa = proxima;
    await repo().save(registro);
    return pergunta(proxima, dadosAtualizados);
  }

  // Última etapa respondida — tenta criar a conta de verdade.
  try {
    const payload = montarPayload(celular, dadosAtualizados);
    const { cliente, token } = await backendClient.criarCliente(payload);
    const { sub: clienteId } = decodificarToken(token);

    await repo().delete({ celular });
    await session.criarOuAtualizarSessao(celular, {
      clienteId,
      clienteSlug: cliente.slug,
      nome: cliente.nomeCompleto,
      token,
    });

    return `Conta criada com sucesso, ${cliente.nomeCompleto.split(' ')[0]}! 🌱 Agora é só me contar o que você quer registrar — ex: "gastei 500 com combustível hoje".`;
  } catch (err: any) {
    const motivo = err.response?.data?.message || 'algum dado ficou inválido';
    console.error(`Erro ao criar conta via onboarding para ${celular}:`, err.response?.data || err.message);
    return reiniciarAposErro(celular, motivo);
  }
}
