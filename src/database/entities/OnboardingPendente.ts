import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Um cadastro por celular em andamento de cada vez — a linha some (removida) quando o
// cadastro é concluído, cancelado, ou falha na criação da conta no backend-safraplan.
export type EtapaOnboarding = 'nome' | 'tipo_documento' | 'documento' | 'cidade' | 'estado' | 'email' | 'senha';

export interface DadosOnboarding {
  nomeCompleto?: string;
  tipoDocumento?: 'CPF' | 'CNPJ';
  documentoValor?: string;
  cidade?: string;
  estado?: string;
  email?: string;
  senha?: string;
}

@Entity('onboarding_pendente')
export class OnboardingPendente {
  @PrimaryColumn({ type: 'varchar' })
  celular!: string;

  @Column({ type: 'varchar', length: 20 })
  etapa!: EtapaOnboarding;

  @Column({ type: 'jsonb', default: {} })
  dados!: DadosOnboarding;

  @CreateDateColumn({ name: 'criado_em' })
  criadoEm!: Date;

  @UpdateDateColumn({ name: 'atualizado_em' })
  atualizadoEm!: Date;
}
