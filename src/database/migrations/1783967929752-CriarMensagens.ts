import { MigrationInterface, QueryRunner } from "typeorm";

export class CriarMensagens1783967929752 implements MigrationInterface {
    name = 'CriarMensagens1783967929752'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "chat"."sessoes_whatsapp" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "criado_em" TIMESTAMP NOT NULL DEFAULT now(), "atualizado_em" TIMESTAMP NOT NULL DEFAULT now(), "celular" character varying NOT NULL, "cliente_id" uuid NOT NULL, "cliente_slug" character varying NOT NULL, "nome" character varying(200), "token" text NOT NULL, "token_criado_em" TIMESTAMP NOT NULL DEFAULT NOW(), "fazenda_padrao_slug" character varying, "contexto_pendente" jsonb, CONSTRAINT "PK_d18cdd82a9251ad2eb8288255d1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "chat"."mensagens" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "criado_em" TIMESTAMP NOT NULL DEFAULT now(), "atualizado_em" TIMESTAMP NOT NULL DEFAULT now(), "celular" character varying NOT NULL, "role" character varying(20) NOT NULL, "content" text NOT NULL, CONSTRAINT "PK_c2ba5218f1bff3363548479d2f3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c0d62ff3e39dba5a9883448595" ON "chat"."mensagens" ("celular", "criado_em") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "chat"."IDX_c0d62ff3e39dba5a9883448595"`);
        await queryRunner.query(`DROP TABLE "chat"."mensagens"`);
        await queryRunner.query(`DROP TABLE "chat"."sessoes_whatsapp"`);
    }

}
