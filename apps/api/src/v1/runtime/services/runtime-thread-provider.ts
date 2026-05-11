import type { ToolRunnableConfig } from '@langchain/core/tools';
import { BadRequestException } from '@packages/common';
import dedent from 'dedent';
import { isString } from 'lodash';

import { environment } from '../../../environments';
import type { BaseAgentConfigurable } from '../../agents/agents.types';
import { ProvideRuntimeInstanceParams } from '../runtime.types';
import { BaseRuntime } from './base-runtime';
import type { ProvideRuntimeResult, RuntimeProvider } from './runtime-provider';

type RuntimeThreadProviderParams = Pick<
  ProvideRuntimeInstanceParams,
  'runtimeNodeId' | 'type' | 'runtimeStartParams' | 'temporary' | 'graphId'
>;

type RuntimeThreadInitJob = (
  runtime: BaseRuntime,
  cfg: ToolRunnableConfig<BaseAgentConfigurable>,
) => Promise<void>;

export class RuntimeThreadProvider {
  private readonly initJobsByNodeId = new Map<
    string,
    Map<string, RuntimeThreadInitJob>
  >();
  private readonly additionalEnv: Record<string, string> = {};

  constructor(
    private readonly runtimeProvider: RuntimeProvider,
    private params: RuntimeThreadProviderParams,
  ) {}

  public setParams(params: RuntimeThreadProviderParams) {
    this.params = params;
  }

  public addEnvVariables(env: Record<string, string>) {
    if (!Object.keys(env).length) {
      return;
    }

    Object.assign(this.additionalEnv, env);
  }

  public getParams(): RuntimeThreadProviderParams {
    return this.params;
  }

  public registerJob(
    executorNodeId: string,
    id: string,
    job: RuntimeThreadInitJob,
  ) {
    const jobs = this.initJobsByNodeId.get(executorNodeId) ?? new Map();
    jobs.set(id, job);
    this.initJobsByNodeId.set(executorNodeId, jobs);
  }

  public removeExecutor(executorNodeId: string) {
    this.initJobsByNodeId.delete(executorNodeId);
  }

  async provide<T extends BaseRuntime>(
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<T> {
    const threadId =
      cfg.configurable?.parent_thread_id || cfg.configurable?.thread_id;
    if (!threadId) {
      throw new BadRequestException(
        undefined,
        'Thread id is required for runtime provisioning',
      );
    }

    let initScript = this.params.runtimeStartParams.initScript || [];
    if (initScript && isString(initScript)) {
      initScript = [initScript];
    }

    const result: ProvideRuntimeResult<T> =
      await this.runtimeProvider.provide<T>({
        ...this.params,
        runtimeStartParams: {
          ...this.params.runtimeStartParams,
          initScript,
          initScriptTimeoutMs:
            this.params.runtimeStartParams.initScriptTimeoutMs ?? 0,
          env: {
            ...(this.params.runtimeStartParams.env || {}),
            ...this.additionalEnv,
          },
        },
        threadId,
      });

    if (!result.cached) {
      await this.runInitJobs(result.runtime, cfg);
    }
    return result.runtime;
  }

  private async runInitJobs(
    runtime: BaseRuntime,
    cfg: ToolRunnableConfig<BaseAgentConfigurable>,
  ): Promise<void> {
    if (this.initJobsByNodeId.size === 0) {
      return;
    }

    for (const jobs of this.initJobsByNodeId.values()) {
      for (const job of jobs.values()) {
        await job(runtime, cfg);
      }
    }
  }

  async cleanup(): Promise<void> {
    this.initJobsByNodeId.clear();
    await this.runtimeProvider.cleanupRuntimesByNodeId(
      this.params.runtimeNodeId,
      this.params.graphId ?? null,
    );
  }

  public getRuntimeInfo(): string {
    const runtimeImage =
      this.params.runtimeStartParams.image ?? environment.dockerRuntimeImage;

    return dedent`
      Runtime type: ${this.params.type}
      ${runtimeImage ? `Runtime image: ${runtimeImage}` : ''}

      Nix package manager:
      - Use Nix when a required dependency is missing from the base runtime.
      - Quick check: \`nix --version\`
      - Ephemeral tools for one command:
        \`nix shell nixpkgs#nodejs_24 nixpkgs#pnpm -c pnpm install\`
      - Install tools into current runtime instance (persists while runtime is alive):
        \`nix profile install nixpkgs#nodejs_24 nixpkgs#pnpm\`
      - If repo has \`flake.nix\`, run project environment:
        \`nix develop -c <command>\`
    `;
  }
}
