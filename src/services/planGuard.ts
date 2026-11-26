import { consultarStatusPlano } from './backendClient';

// Returns null if plan is ok, or a block message if the plan is inadimplente/cancelada.
export async function verificarPlano(celular: string): Promise<string | null> {
  const { status } = await consultarStatusPlano(celular);

  if (status === 'inadimplente' || status === 'cancelada') {
    return (
      '🔒 *Plano vencido!*\n\n' +
      'Seus lançamentos estão bloqueados. Para renovar seu plano e continuar usando, responda:\n\n' +
      '*RENOVAR* — receber link de pagamento Pix'
    );
  }

  return null;
}

// Returns a warning string to append when plan expires in <= 7 days, or null otherwise.
export async function avisoVencimentoProximo(celular: string): Promise<string | null> {
  const { status, diasRestantes } = await consultarStatusPlano(celular);
  if (status === 'ativa' && typeof diasRestantes === 'number' && diasRestantes > 0 && diasRestantes <= 7) {
    return `\n\n⏰ _Lembrete: seu plano vence em ${diasRestantes} dia(s). Responda *RENOVAR* para renovar._`;
  }
  return null;
}
