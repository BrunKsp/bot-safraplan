import { MigrationInterface, QueryRunner } from "typeorm";

export class CriarOnboardingPendente1790200000000 implements MigrationInterface {
    name = 'CriarOnboardingPendente1790200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "chat"."onboarding_pendente" ("celular" character varying NOT NULL, "etapa" character varying(20) NOT NULL, "dados" jsonb NOT NULL DEFAULT '{}', "criado_em" TIMESTAMP NOT NULL DEFAULT now(), "atualizado_em" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_onboarding_pendente_celular" PRIMARY KEY ("celular"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "chat"."onboarding_pendente"`);
    }

}
