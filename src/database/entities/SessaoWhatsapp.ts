import { Column, Entity } from 'typeorm';
import { BaseEntity } from './BaseEntity';

export interface ContextoPendente {
  campos: Record<string, unknown>;
  perguntando: string;
}

@Entity('sessoes_whatsapp')
export class SessaoWhatsapp extends BaseEntity {
  @Column()
  celular!: string;

  @Column({ name: 'cliente_id', type: 'uuid' })
  clienteId!: string;

  @Column({ name: 'cliente_slug' })
  clienteSlug!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  nome!: string | null;

  @Column({ type: 'text' })
  token!: string;

  @Column({ name: 'token_criado_em', type: 'timestamp', default: () => 'NOW()' })
  tokenCriadoEm!: Date;

  @Column({ name: 'fazenda_padrao_slug', type: 'varchar', nullable: true })
  fazendaPadraoSlug!: string | null;

  @Column({ name: 'contexto_pendente', type: 'jsonb', nullable: true })
  contextoPendente!: ContextoPendente | null;
}
