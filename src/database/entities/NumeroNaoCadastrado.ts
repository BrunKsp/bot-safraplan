import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// Um número que mandou mensagem sem ter conta no SafraPlan. A primeira mensagem recebe a
// orientação padrão pra se cadastrar pelo site; a partir da segunda, o bot fica calado pra esse
// número (evita ficar repetindo a mesma mensagem pra spam/robô de cobrança etc. — ver
// conversation.ts). Removido manualmente (DELETE /interno/numeros-bloqueados/:celular) quando o
// número deve voltar a receber resposta.
@Entity('numeros_nao_cadastrados')
export class NumeroNaoCadastrado {
  @PrimaryColumn({ type: 'varchar' })
  celular!: string;

  @CreateDateColumn({ name: 'criado_em' })
  criadoEm!: Date;

  @Column({ name: 'mensagens_ignoradas', type: 'int', default: 0 })
  mensagensIgnoradas!: number;
}
