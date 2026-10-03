import { MigrationInterface, QueryRunner } from "typeorm";

export class CriarNumerosNaoCadastradosERemoverOnboarding1790300000000 implements MigrationInterface {
    name = 'CriarNumerosNaoCadastradosERemoverOnboarding1790300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "chat"."numeros_nao_cadastrados" ("celular" character varying NOT NULL, "criado_em" TIMESTAMP NOT NULL DEFAULT now(), "mensagens_ignoradas" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_numeros_nao_cadastrados_celular" PRIMARY KEY ("celular"))`);
        await queryRunner.query(`DROP TABLE "chat"."onboarding_pendente"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "chat"."onboarding_pendente" ("celular" character varying NOT NULL, "etapa" character varying(20) NOT NULL, "dados" jsonb NOT NULL DEFAULT '{}', "criado_em" TIMESTAMP NOT NULL DEFAULT now(), "atualizado_em" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_onboarding_pendente_celular" PRIMARY KEY ("celular"))`);
        await queryRunner.query(`DROP TABLE "chat"."numeros_nao_cadastrados"`);
    }

}
