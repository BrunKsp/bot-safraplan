import { CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Campos comuns a todas as entidades do bot (mesmo padrão do backend-safraplan): id em uuid
// gerado pelo Postgres, e os timestamps de criação/atualização geridos pelo TypeORM.
export abstract class BaseEntity {
  @PrimaryColumn('uuid', { default: () => 'gen_random_uuid()' })
  id!: string;

  @CreateDateColumn({ name: 'criado_em' })
  criadoEm!: Date;

  @UpdateDateColumn({ name: 'atualizado_em' })
  atualizadoEm!: Date;
}
