import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './BaseEntity';

export type PapelMensagem = 'user' | 'assistant';

@Entity('mensagens')
@Index(['celular', 'criadoEm'])
export class Mensagem extends BaseEntity {
  @Column()
  celular!: string;

  @Column({ type: 'varchar', length: 20 })
  role!: PapelMensagem;

  @Column({ type: 'text' })
  content!: string;
}
