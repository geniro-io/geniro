import { Migration } from '@mikro-orm/migrations';

export class Generated1759225623237 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    this.addSql(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    this.addSql(`
            CREATE TABLE "graph_checkpoints" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "threadId" character varying NOT NULL,
                "checkpointNs" character varying NOT NULL DEFAULT '',
                "checkpointId" character varying NOT NULL,
                "parentCheckpointId" character varying,
                "type" character varying NOT NULL,
                "checkpoint" bytea NOT NULL,
                "metadata" bytea NOT NULL,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_2739e90f63ccbd3ec1b2b4baf4a" PRIMARY KEY ("id")
            )
        `);
    this.addSql(`
            CREATE UNIQUE INDEX "IDX_5efb40becb5b10edac9b6934c3" ON "graph_checkpoints" ("threadId", "checkpointNs", "checkpointId")
        `);
    this.addSql(`
            CREATE TABLE "graph_checkpoint_writes" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "threadId" character varying NOT NULL,
                "checkpointNs" character varying NOT NULL DEFAULT '',
                "checkpointId" character varying NOT NULL,
                "taskId" character varying NOT NULL,
                "idx" integer NOT NULL,
                "channel" character varying NOT NULL,
                "type" character varying NOT NULL,
                "value" bytea NOT NULL,
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_80475d6b7a7bbf6a3c9c11a1f00" PRIMARY KEY ("id")
            )
        `);
    this.addSql(`
            CREATE UNIQUE INDEX "IDX_bb6786a7e802321198ea9036a0" ON "graph_checkpoint_writes" (
                "threadId",
                "checkpointNs",
                "checkpointId",
                "taskId",
                "idx"
            )
        `);
  }

  override async down(): Promise<void> {
    this.addSql(`
            DROP INDEX "public"."IDX_bb6786a7e802321198ea9036a0"
        `);
    this.addSql(`
            DROP TABLE "graph_checkpoint_writes"
        `);
    this.addSql(`
            DROP INDEX "public"."IDX_5efb40becb5b10edac9b6934c3"
        `);
    this.addSql(`
            DROP TABLE "graph_checkpoints"
        `);
  }
}
