import { Migration } from '@mikro-orm/migrations';

export class Migration20260329165441 extends Migration {
  override up(): void | Promise<void> {
    this.addSql(`drop table if exists "knowledge_chunks" cascade;`);
    this.addSql(`drop table if exists "migrations" cascade;`);

    this.addSql(
      `alter table "repo_indexes" drop constraint if exists "FK_001a3ccf8144b1061e35a7a7b5b";`,
    );

    this.addSql(
      `alter table "threads" drop constraint if exists "FK_6702c6b1e71ab29e51030281832";`,
    );

    this.addSql(
      `alter table "messages" drop constraint if exists "FK_15f9bd2bf472ff12b6ee20012d0";`,
    );

    this.addSql(
      `alter table "git_provider_connections" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "user_id" type varchar(255) using ("user_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "account_login" type varchar(255) using ("account_login"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "provider" type varchar(255) using ("provider"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_0d463e583f3363c4a3b1d179d9" rename to "git_provider_connections_user_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_4e2c304727084db04db41794e8" rename to "git_provider_connections_provider_index";`,
    );
    this.addSql(
      `alter table "git_provider_connections" drop constraint if exists "UQ_d33e8a47a1b87f23975eec7bee7";`,
    );
    this.addSql(
      `alter table "git_provider_connections" add constraint "git_provider_connections_user_id_provider_account_login_unique" unique ("user_id", "provider", "account_login");`,
    );

    this.addSql(
      `alter table "git_repositories" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "owner" type varchar(255) using ("owner"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "repo" type varchar(255) using ("repo"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "url" type varchar(255) using ("url"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "provider" type text using ("provider"::text);`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "default_branch" type varchar(255) using ("default_branch"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_cdd40dd1e9a0c0ea2d77ea9f48" rename to "git_repositories_created_by_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_21cc46a19a72cc0fb71d443676" rename to "git_repositories_project_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_ac33bc6a5803234be00dc839bc" rename to "git_repositories_owner_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_d9121f1e2ce469c0f140253b0f" rename to "git_repositories_repo_index";`,
    );
    this.addSql(`drop index if exists "IDX_0c83196e1a740179647ff52872";`);
    this.addSql(
      `alter table "git_repositories" add constraint "git_repositories_owner_repo_created_by_provider_unique" unique ("owner", "repo", "created_by", "provider");`,
    );
    this.addSql(
      `alter table "git_repositories" add constraint "git_repositories_provider_check" check ("provider" in ('GITHUB'));`,
    );

    this.addSql(
      `alter table "graph_checkpoints" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "thread_id" type varchar(255) using ("thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "checkpoint_ns" type varchar(255) using ("checkpoint_ns"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "checkpoint_id" type varchar(255) using ("checkpoint_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "parent_checkpoint_id" type varchar(255) using ("parent_checkpoint_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "type" type varchar(255) using ("type"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "parent_thread_id" type varchar(255) using ("parent_thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "node_id" type varchar(255) using ("node_id"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_3cab3aab51c7394a1133560768" rename to "graph_checkpoints_parent_thread_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_bf2c48c6e6ae3bffe3b737dbda" rename to "graph_checkpoints_node_id_index";`,
    );
    this.addSql(`drop index if exists "IDX_5efb40becb5b10edac9b6934c3";`);
    this.addSql(
      `alter table "graph_checkpoints" add constraint "graph_checkpoints_thread_id_checkpoint_ns_checkpoint_id_unique" unique ("thread_id", "checkpoint_ns", "checkpoint_id");`,
    );

    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "thread_id" type varchar(255) using ("thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "checkpoint_ns" type varchar(255) using ("checkpoint_ns"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "checkpoint_id" type varchar(255) using ("checkpoint_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "task_id" type varchar(255) using ("task_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "channel" type varchar(255) using ("channel"::varchar(255));`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "type" type varchar(255) using ("type"::varchar(255));`,
    );
    this.addSql(`drop index if exists "IDX_bb6786a7e802321198ea9036a0";`);
    this.addSql(
      `alter table "graph_checkpoint_writes" add constraint "graph_checkpoint_writes_thread_id_checkpoint_ns_c_1fadd_unique" unique ("thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx");`,
    );

    this.addSql(
      `alter table "graphs" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "graphs" alter column "status" type text using ("status"::text);`,
    );
    this.addSql(
      `alter table "graphs" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_2db6fd00099882ad81ce3a5be4" rename to "graphs_created_by_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_16c67c5ed33f8ad80686455df5" rename to "graphs_project_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_4b71a57204c9102cdc0c1a9f51" rename to "graphs_status_index";`,
    );
    this.addSql(
      `alter table "graphs" add constraint "graphs_status_check" check ("status" in ('created', 'compiling', 'running', 'stopped', 'error'));`,
    );

    this.addSql(
      `alter table "graph_revisions" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "graph_revisions" alter column "status" type text using ("status"::text);`,
    );
    this.addSql(
      `alter table "graph_revisions" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_c16df53f74a9053299af7a1740" rename to "graph_revisions_graph_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_9c3be1885dfe18d1c59675de45" rename to "graph_revisions_status_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_8656c524a47fa65047677f6825" rename to "graph_revisions_created_by_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_31c0acef25b5e1204c253aaad1" rename to "graph_revisions_graph_id_to_version_index";`,
    );
    this.addSql(
      `alter table "graph_revisions" add constraint "graph_revisions_status_check" check ("status" in ('pending', 'applying', 'applied', 'failed'));`,
    );

    this.addSql(
      `alter table "knowledge_docs" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "knowledge_docs" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_68cd1c26fb287057a76150f247" rename to "knowledge_docs_created_by_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_e847cd5e64a00441fb254b4248" rename to "knowledge_docs_project_id_index";`,
    );
    this.addSql(`drop index if exists "IDX_df44a1b6f684c23d7a325dcafd";`);
    this.addSql(
      `alter table "knowledge_docs" add constraint "knowledge_docs_public_id_unique" unique ("public_id");`,
    );

    this.addSql(
      `alter table "projects" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "projects" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter index if exists "IDX_4fcfae511b4f6aaa67a8d32596" rename to "projects_created_by_index";`,
    );

    this.addSql(
      `alter table "repo_indexes" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "repo_url" type varchar(255) using ("repo_url"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "status" type text using ("status"::text);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "qdrant_collection" type varchar(255) using ("qdrant_collection"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "last_indexed_commit" type varchar(255) using ("last_indexed_commit"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "embedding_model" type varchar(255) using ("embedding_model"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "chunking_signature_hash" type varchar(255) using ("chunking_signature_hash"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "branch" type varchar(255) using ("branch"::varchar(255));`,
    );
    this.addSql(
      `alter table "repo_indexes" add constraint "repo_indexes_repository_id_foreign" foreign key ("repository_id") references "git_repositories" ("id") on delete cascade;`,
    );
    this.addSql(
      `create index "repo_indexes_repository_id_index" on "repo_indexes" ("repository_id");`,
    );
    this.addSql(
      `alter index if exists "IDX_1de5896f100d9e9b87875424ac" rename to "repo_indexes_status_index";`,
    );
    this.addSql(`drop index if exists "IDX_3e1b2818aefe61b9141a48eb6e";`);
    this.addSql(
      `alter table "repo_indexes" add constraint "repo_indexes_repository_id_branch_unique" unique ("repository_id", "branch");`,
    );
    this.addSql(
      `alter table "repo_indexes" add constraint "repo_indexes_status_check" check ("status" in ('pending', 'in_progress', 'completed', 'failed'));`,
    );

    this.addSql(`drop index if exists "IDX_edbcf394ee253b1671a282b5ec";`);
    this.addSql(
      `alter table "runtime_instances" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "node_id" type varchar(255) using ("node_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "thread_id" type varchar(255) using ("thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "type" type text using ("type"::text);`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "status" type text using ("status"::text);`,
    );
    this.addSql(
      `create index "runtime_instances_graph_id_node_id_thread_id_index" on "runtime_instances" ("graph_id", "node_id", "thread_id");`,
    );
    this.addSql(
      `alter index if exists "IDX_9d7d3e71a836499597201eb7ca" rename to "runtime_instances_graph_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_9c8681731cc6cc3f8e1d8616ee" rename to "runtime_instances_thread_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_cc42483a7c938297472ef633c9" rename to "runtime_instances_status_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_aee88a311dcb1339c9c5d7314b" rename to "runtime_instances_last_used_at_index";`,
    );
    this.addSql(
      `alter table "runtime_instances" add constraint "runtime_instances_type_check" check ("type" in ('Docker', 'Daytona'));`,
    );
    this.addSql(
      `alter table "runtime_instances" add constraint "runtime_instances_status_check" check ("status" in ('Starting', 'Running', 'Stopping', 'Stopped', 'Failed'));`,
    );

    this.addSql(
      `alter table "threads" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "threads" alter column "created_by" type varchar(255) using ("created_by"::varchar(255));`,
    );
    this.addSql(
      `alter table "threads" alter column "external_thread_id" type varchar(255) using ("external_thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "threads" alter column "source" type varchar(255) using ("source"::varchar(255));`,
    );
    this.addSql(
      `alter table "threads" alter column "name" type varchar(255) using ("name"::varchar(255));`,
    );
    this.addSql(
      `alter table "threads" alter column "status" type varchar(255) using ("status"::varchar(255));`,
    );
    this.addSql(
      `alter table "threads" add constraint "threads_graph_id_foreign" foreign key ("graph_id") references "graphs" ("id") on delete cascade;`,
    );
    this.addSql(
      `alter index if exists "IDX_d288e139037a4de52d00e42e78" rename to "threads_created_by_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_3acbab3c91ef7c75eb0709f44f" rename to "threads_project_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_6702c6b1e71ab29e5103028183" rename to "threads_graph_id_index";`,
    );
    this.addSql(`drop index if exists "IDX_2aecc6fa23e93aacd536433927";`);
    this.addSql(
      `alter table "threads" add constraint "threads_external_thread_id_unique" unique ("external_thread_id");`,
    );
    this.addSql(
      `alter index if exists "IDX_c69829dccdf02bb79717b83271" rename to "threads_status_index";`,
    );

    this.addSql(
      `alter table "messages" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "messages" alter column "external_thread_id" type varchar(255) using ("external_thread_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "messages" alter column "node_id" type varchar(255) using ("node_id"::varchar(255));`,
    );
    this.addSql(
      `alter table "messages" alter column "role" type varchar(255) using ("role"::varchar(255));`,
    );
    this.addSql(
      `alter table "messages" alter column "name" type varchar(255) using ("name"::varchar(255));`,
    );
    this.addSql(
      `alter table "messages" add constraint "messages_thread_id_foreign" foreign key ("thread_id") references "threads" ("id") on delete cascade;`,
    );
    this.addSql(
      `alter index if exists "IDX_15f9bd2bf472ff12b6ee20012d" rename to "messages_thread_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_0d56ed722567bad03618f7e02b" rename to "messages_external_thread_id_index";`,
    );
    this.addSql(
      `alter index if exists "IDX_7f5346b8f042a49c31dbf19870" rename to "messages_node_id_index";`,
    );

    this.addSql(
      `alter table "user_preference" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "user_preference" alter column "user_id" type varchar(255) using ("user_id"::varchar(255));`,
    );
    this.addSql(`drop index if exists "IDX_5b141fbd1fef95a0540f7e7d1e";`);
    this.addSql(
      `alter table "user_preference" add constraint "user_preference_user_id_unique" unique ("user_id");`,
    );

    this.addSql(
      `alter table "webhook_processed_event" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "webhook_processed_event" alter column "dedup_key" type varchar(255) using ("dedup_key"::varchar(255));`,
    );
    this.addSql(`drop index if exists "IDX_0b1a099caaca931750e46b4c3c";`);
    this.addSql(
      `alter table "webhook_processed_event" add constraint "webhook_processed_event_dedup_key_unique" unique ("dedup_key");`,
    );

    this.addSql(
      `alter table "webhook_sync_state" alter column "id" set default gen_random_uuid();`,
    );
    this.addSql(
      `alter table "webhook_sync_state" alter column "type" type text using ("type"::text);`,
    );
    this.addSql(`drop index if exists "IDX_56701d1f07abeeab125ab93452";`);
    this.addSql(
      `alter table "webhook_sync_state" add constraint "webhook_sync_state_type_unique" unique ("type");`,
    );
    this.addSql(
      `alter table "webhook_sync_state" add constraint "webhook_sync_state_type_check" check ("type" in ('gh_issue'));`,
    );

    // Drop enum-typed defaults before dropping the enum types
    this.addSql(
      `alter table "graph_revisions" alter column "status" drop default;`,
    );
    this.addSql(`alter table "graphs" alter column "status" drop default;`);
    this.addSql(
      `alter table "runtime_instances" alter column "status" drop default;`,
    );

    this.addSql(`drop type if exists "git_repositories_provider_enum";`);
    this.addSql(`drop type if exists "graph_revisions_status_enum";`);
    this.addSql(`drop type if exists "graphs_status_enum";`);
    this.addSql(`drop type if exists "repo_indexes_status_enum";`);
    this.addSql(`drop type if exists "runtime_instances_status_enum";`);
    this.addSql(`drop type if exists "runtime_instances_type_enum";`);
    this.addSql(`drop type if exists "webhook_sync_state_type_enum";`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `create type "git_repositories_provider_enum" as enum ('GITHUB');`,
    );
    this.addSql(
      `create type "graph_revisions_status_enum" as enum ('pending', 'applying', 'applied', 'failed');`,
    );
    this.addSql(
      `create type "graphs_status_enum" as enum ('created', 'compiling', 'running', 'stopped', 'error');`,
    );
    this.addSql(
      `create type "repo_indexes_status_enum" as enum ('pending', 'in_progress', 'completed', 'failed');`,
    );
    this.addSql(
      `create type "runtime_instances_status_enum" as enum ('Starting', 'Running', 'Stopping', 'Stopped', 'Failed');`,
    );
    this.addSql(
      `create type "runtime_instances_type_enum" as enum ('Docker', 'Daytona');`,
    );
    this.addSql(
      `create type "webhook_sync_state_type_enum" as enum ('gh_issue');`,
    );
    this.addSql(
      `create table "knowledge_chunks" ("createdAt" timestamptz(6) not null default now(), "updatedAt" timestamptz(6) not null default now(), "deletedAt" timestamptz(6) null, "id" uuid not null default uuid_generate_v4(), "docId" uuid not null, "chunkIndex" int4 not null, "label" varchar null, "keywords" jsonb null, "text" text not null, "startOffset" int4 not null, "endOffset" int4 not null, "embedding" vector null, "publicId" serial, constraint "PK_81af684d79d321813c41019a5cd" primary key ("id"));`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX "IDX_1057f9147e2cc20ceec7af0bb5" ON public.knowledge_chunks USING btree ("publicId");`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX "IDX_a4cfbf5997a69dc9bd11934e7e" ON public.knowledge_chunks USING btree ("docId", "chunkIndex");`,
    );
    this.addSql(
      `CREATE INDEX "IDX_b00cc8a813624a42dc9fd5e321" ON public.knowledge_chunks USING btree ("docId");`,
    );

    this.addSql(
      `create table "migrations" ("id" serial, "timestamp" int8 not null, "name" varchar not null, constraint "PK_8c82d7f526340ab734260ea46be" primary key ("id"));`,
    );

    this.addSql(
      `alter table "graph_revisions" alter column "status" drop default;`,
    );

    this.addSql(`alter table "graphs" alter column "status" drop default;`);

    this.addSql(
      `alter table "messages" drop constraint if exists "messages_thread_id_foreign";`,
    );

    this.addSql(
      `alter table "repo_indexes" drop constraint if exists "repo_indexes_repository_id_foreign";`,
    );

    this.addSql(
      `alter table "runtime_instances" alter column "status" drop default;`,
    );

    this.addSql(
      `alter table "threads" drop constraint if exists "threads_graph_id_foreign";`,
    );

    this.addSql(
      `alter table "git_provider_connections" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "user_id" type varchar using ("user_id"::varchar);`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "provider" type varchar using ("provider"::varchar);`,
    );
    this.addSql(
      `alter table "git_provider_connections" alter column "account_login" type varchar using ("account_login"::varchar);`,
    );
    this.addSql(
      `alter index "git_provider_connections_user_id_index" rename to "IDX_0d463e583f3363c4a3b1d179d9";`,
    );
    this.addSql(
      `alter index "git_provider_connections_provider_index" rename to "IDX_4e2c304727084db04db41794e8";`,
    );
    this.addSql(
      `alter table "git_provider_connections" drop constraint if exists "git_provider_connections_user_id_provider_account_login_unique";`,
    );
    this.addSql(
      `alter table "git_provider_connections" add constraint "UQ_d33e8a47a1b87f23975eec7bee7" unique ("user_id", "provider", "account_login");`,
    );

    this.addSql(
      `alter table "git_repositories" drop constraint if exists "git_repositories_provider_check";`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "owner" type varchar using ("owner"::varchar);`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "repo" type varchar using ("repo"::varchar);`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "url" type varchar using ("url"::varchar);`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "provider" type "git_repositories_provider_enum" using ("provider"::"git_repositories_provider_enum");`,
    );
    this.addSql(
      `alter table "git_repositories" alter column "default_branch" type varchar using ("default_branch"::varchar);`,
    );
    this.addSql(
      `drop index "git_repositories_owner_repo_created_by_provider_unique";`,
    );
    this.addSql(
      `create unique index "IDX_0c83196e1a740179647ff52872" on "git_repositories" ("owner", "repo", "created_by", "provider");`,
    );
    this.addSql(
      `alter index "git_repositories_project_id_index" rename to "IDX_21cc46a19a72cc0fb71d443676";`,
    );
    this.addSql(
      `alter index "git_repositories_owner_index" rename to "IDX_ac33bc6a5803234be00dc839bc";`,
    );
    this.addSql(
      `alter index "git_repositories_created_by_index" rename to "IDX_cdd40dd1e9a0c0ea2d77ea9f48";`,
    );
    this.addSql(
      `alter index "git_repositories_repo_index" rename to "IDX_d9121f1e2ce469c0f140253b0f";`,
    );

    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "thread_id" type varchar using ("thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "checkpoint_ns" type varchar using ("checkpoint_ns"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "checkpoint_id" type varchar using ("checkpoint_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "task_id" type varchar using ("task_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "channel" type varchar using ("channel"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoint_writes" alter column "type" type varchar using ("type"::varchar);`,
    );
    this.addSql(
      `drop index "graph_checkpoint_writes_thread_id_checkpoint_ns_c_1fadd_unique";`,
    );
    this.addSql(
      `create unique index "IDX_bb6786a7e802321198ea9036a0" on "graph_checkpoint_writes" ("thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx");`,
    );

    this.addSql(
      `alter table "graph_checkpoints" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "thread_id" type varchar using ("thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "parent_thread_id" type varchar using ("parent_thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "node_id" type varchar using ("node_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "checkpoint_ns" type varchar using ("checkpoint_ns"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "checkpoint_id" type varchar using ("checkpoint_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "parent_checkpoint_id" type varchar using ("parent_checkpoint_id"::varchar);`,
    );
    this.addSql(
      `alter table "graph_checkpoints" alter column "type" type varchar using ("type"::varchar);`,
    );
    this.addSql(
      `alter index "graph_checkpoints_parent_thread_id_index" rename to "IDX_3cab3aab51c7394a1133560768";`,
    );
    this.addSql(
      `drop index "graph_checkpoints_thread_id_checkpoint_ns_checkpoint_id_unique";`,
    );
    this.addSql(
      `create unique index "IDX_5efb40becb5b10edac9b6934c3" on "graph_checkpoints" ("thread_id", "checkpoint_ns", "checkpoint_id");`,
    );
    this.addSql(
      `alter index "graph_checkpoints_node_id_index" rename to "IDX_bf2c48c6e6ae3bffe3b737dbda";`,
    );

    this.addSql(
      `alter table "graph_revisions" drop constraint if exists "graph_revisions_status_check";`,
    );
    this.addSql(
      `alter table "graph_revisions" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "graph_revisions" alter column "status" type "graph_revisions_status_enum" using ("status"::"graph_revisions_status_enum");`,
    );
    this.addSql(
      `alter table "graph_revisions" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter index "graph_revisions_graph_id_to_version_index" rename to "IDX_31c0acef25b5e1204c253aaad1";`,
    );
    this.addSql(
      `alter index "graph_revisions_created_by_index" rename to "IDX_8656c524a47fa65047677f6825";`,
    );
    this.addSql(
      `alter index "graph_revisions_status_index" rename to "IDX_9c3be1885dfe18d1c59675de45";`,
    );
    this.addSql(
      `alter index "graph_revisions_graph_id_index" rename to "IDX_c16df53f74a9053299af7a1740";`,
    );

    this.addSql(
      `alter table "graphs" drop constraint if exists "graphs_status_check";`,
    );
    this.addSql(
      `alter table "graphs" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "graphs" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter table "graphs" alter column "status" type "graphs_status_enum" using ("status"::"graphs_status_enum");`,
    );
    this.addSql(
      `alter index "graphs_project_id_index" rename to "IDX_16c67c5ed33f8ad80686455df5";`,
    );
    this.addSql(
      `alter index "graphs_created_by_index" rename to "IDX_2db6fd00099882ad81ce3a5be4";`,
    );
    this.addSql(
      `alter index "graphs_status_index" rename to "IDX_4b71a57204c9102cdc0c1a9f51";`,
    );

    this.addSql(
      `alter table "knowledge_docs" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "knowledge_docs" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter index "knowledge_docs_created_by_index" rename to "IDX_68cd1c26fb287057a76150f247";`,
    );
    this.addSql(`drop index "knowledge_docs_public_id_unique";`);
    this.addSql(
      `create unique index "IDX_df44a1b6f684c23d7a325dcafd" on "knowledge_docs" ("public_id");`,
    );
    this.addSql(
      `alter index "knowledge_docs_project_id_index" rename to "IDX_e847cd5e64a00441fb254b4248";`,
    );

    this.addSql(
      `alter table "messages" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "messages" alter column "external_thread_id" type varchar using ("external_thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "messages" alter column "node_id" type varchar using ("node_id"::varchar);`,
    );
    this.addSql(
      `alter table "messages" alter column "role" type varchar using ("role"::varchar);`,
    );
    this.addSql(
      `alter table "messages" alter column "name" type varchar using ("name"::varchar);`,
    );
    this.addSql(
      `alter table "messages" add constraint "FK_15f9bd2bf472ff12b6ee20012d0" foreign key ("thread_id") references "threads" ("id") on update no action on delete cascade;`,
    );
    this.addSql(
      `alter index "messages_external_thread_id_index" rename to "IDX_0d56ed722567bad03618f7e02b";`,
    );
    this.addSql(
      `alter index "messages_thread_id_index" rename to "IDX_15f9bd2bf472ff12b6ee20012d";`,
    );
    this.addSql(
      `alter index "messages_node_id_index" rename to "IDX_7f5346b8f042a49c31dbf19870";`,
    );

    this.addSql(
      `alter table "projects" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "projects" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter index "projects_created_by_index" rename to "IDX_4fcfae511b4f6aaa67a8d32596";`,
    );

    this.addSql(`drop index "repo_indexes_repository_id_index";`);
    this.addSql(
      `alter table "repo_indexes" drop constraint if exists "repo_indexes_status_check";`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "repo_url" type varchar using ("repo_url"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "branch" type varchar using ("branch"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "status" type "repo_indexes_status_enum" using ("status"::"repo_indexes_status_enum");`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "qdrant_collection" type varchar using ("qdrant_collection"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "last_indexed_commit" type varchar using ("last_indexed_commit"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "embedding_model" type varchar using ("embedding_model"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" alter column "chunking_signature_hash" type varchar using ("chunking_signature_hash"::varchar);`,
    );
    this.addSql(
      `alter table "repo_indexes" add constraint "FK_001a3ccf8144b1061e35a7a7b5b" foreign key ("repository_id") references "git_repositories" ("id") on update no action on delete cascade;`,
    );
    this.addSql(
      `alter index "repo_indexes_status_index" rename to "IDX_1de5896f100d9e9b87875424ac";`,
    );
    this.addSql(`drop index "repo_indexes_repository_id_branch_unique";`);
    this.addSql(
      `create unique index "IDX_3e1b2818aefe61b9141a48eb6e" on "repo_indexes" ("repository_id", "branch");`,
    );

    this.addSql(
      `drop index "runtime_instances_graph_id_node_id_thread_id_index";`,
    );
    this.addSql(
      `alter table "runtime_instances" drop constraint if exists "runtime_instances_type_check";`,
    );
    this.addSql(
      `alter table "runtime_instances" drop constraint if exists "runtime_instances_status_check";`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "node_id" type varchar using ("node_id"::varchar);`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "thread_id" type varchar using ("thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "type" type "runtime_instances_type_enum" using ("type"::"runtime_instances_type_enum");`,
    );
    this.addSql(
      `alter table "runtime_instances" alter column "status" type "runtime_instances_status_enum" using ("status"::"runtime_instances_status_enum");`,
    );
    this.addSql(
      `create unique index "IDX_edbcf394ee253b1671a282b5ec" on "runtime_instances" ("graph_id", "node_id", "thread_id");`,
    );
    this.addSql(
      `alter index "runtime_instances_thread_id_index" rename to "IDX_9c8681731cc6cc3f8e1d8616ee";`,
    );
    this.addSql(
      `alter index "runtime_instances_graph_id_index" rename to "IDX_9d7d3e71a836499597201eb7ca";`,
    );
    this.addSql(
      `alter index "runtime_instances_last_used_at_index" rename to "IDX_aee88a311dcb1339c9c5d7314b";`,
    );
    this.addSql(
      `alter index "runtime_instances_status_index" rename to "IDX_cc42483a7c938297472ef633c9";`,
    );

    this.addSql(
      `alter table "threads" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "threads" alter column "created_by" type varchar using ("created_by"::varchar);`,
    );
    this.addSql(
      `alter table "threads" alter column "external_thread_id" type varchar using ("external_thread_id"::varchar);`,
    );
    this.addSql(
      `alter table "threads" alter column "source" type varchar using ("source"::varchar);`,
    );
    this.addSql(
      `alter table "threads" alter column "name" type varchar using ("name"::varchar);`,
    );
    this.addSql(
      `alter table "threads" alter column "status" type varchar using ("status"::varchar);`,
    );
    this.addSql(
      `alter table "threads" add constraint "FK_6702c6b1e71ab29e51030281832" foreign key ("graph_id") references "graphs" ("id") on update no action on delete cascade;`,
    );
    this.addSql(`drop index "threads_external_thread_id_unique";`);
    this.addSql(
      `create unique index "IDX_2aecc6fa23e93aacd536433927" on "threads" ("external_thread_id");`,
    );
    this.addSql(
      `alter index "threads_project_id_index" rename to "IDX_3acbab3c91ef7c75eb0709f44f";`,
    );
    this.addSql(
      `alter index "threads_graph_id_index" rename to "IDX_6702c6b1e71ab29e5103028183";`,
    );
    this.addSql(
      `alter index "threads_status_index" rename to "IDX_c69829dccdf02bb79717b83271";`,
    );
    this.addSql(
      `alter index "threads_created_by_index" rename to "IDX_d288e139037a4de52d00e42e78";`,
    );

    this.addSql(
      `alter table "user_preference" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "user_preference" alter column "user_id" type varchar using ("user_id"::varchar);`,
    );
    this.addSql(`drop index "user_preference_user_id_unique";`);
    this.addSql(
      `create unique index "IDX_5b141fbd1fef95a0540f7e7d1e" on "user_preference" ("user_id");`,
    );

    this.addSql(
      `alter table "webhook_processed_event" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "webhook_processed_event" alter column "dedup_key" type varchar using ("dedup_key"::varchar);`,
    );
    this.addSql(`drop index "webhook_processed_event_dedup_key_unique";`);
    this.addSql(
      `create unique index "IDX_0b1a099caaca931750e46b4c3c" on "webhook_processed_event" ("dedup_key");`,
    );

    this.addSql(
      `alter table "webhook_sync_state" drop constraint if exists "webhook_sync_state_type_check";`,
    );
    this.addSql(
      `alter table "webhook_sync_state" alter column "id" set default uuid_generate_v4();`,
    );
    this.addSql(
      `alter table "webhook_sync_state" alter column "type" type "webhook_sync_state_type_enum" using ("type"::"webhook_sync_state_type_enum");`,
    );
    this.addSql(`drop index "webhook_sync_state_type_unique";`);
    this.addSql(
      `create unique index "IDX_56701d1f07abeeab125ab93452" on "webhook_sync_state" ("type");`,
    );

    this.addSql(
      `alter table "graph_revisions" alter column "status" set default 'pending';`,
    );

    this.addSql(
      `alter table "graphs" alter column "status" set default 'created';`,
    );

    this.addSql(
      `alter table "runtime_instances" alter column "status" set default 'Starting';`,
    );
  }
}
