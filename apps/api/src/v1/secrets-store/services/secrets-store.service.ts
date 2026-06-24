import { Injectable } from '@nestjs/common';
import { DefaultLogger, InternalException } from '@packages/common';

import { environment } from '../../../environments';

@Injectable()
export class SecretsStoreService {
  constructor(private readonly logger: DefaultLogger) {}

  /**
   * Returns true when OpenBao connection is configured via environment variables.
   * All methods will throw if this returns false.
   */
  isAvailable(): boolean {
    return Boolean(environment.openbaoAddr && environment.openbaoToken);
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new InternalException(
        'SECRETS_STORE_UNAVAILABLE',
        'OpenBao is not configured. Set OPENBAO_ADDR and OPENBAO_TOKEN.',
      );
    }
  }

  private buildDataPath(projectId: string, secretName: string): string {
    return `${environment.openbaoAddr}/v1/secret/data/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(secretName)}`;
  }

  private buildMetadataPath(projectId: string, secretName: string): string {
    return `${environment.openbaoAddr}/v1/secret/metadata/projects/${encodeURIComponent(projectId)}/${encodeURIComponent(secretName)}`;
  }

  private buildUserDataPath(userId: string, secretName: string): string {
    return `${environment.openbaoAddr}/v1/secret/data/users/${encodeURIComponent(userId)}/${encodeURIComponent(secretName)}`;
  }

  private buildUserMetadataPath(userId: string, secretName: string): string {
    return `${environment.openbaoAddr}/v1/secret/metadata/users/${encodeURIComponent(userId)}/${encodeURIComponent(secretName)}`;
  }

  private get authHeaders(): Record<string, string> {
    return {
      'X-Vault-Token': environment.openbaoToken,
      'Content-Type': 'application/json',
    };
  }

  private async request(
    url: string,
    options: RequestInit,
    errorCode: string,
    operationName: string,
  ): Promise<Response> {
    const response = await fetch(url, {
      ...options,
      headers: this.authHeaders,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.debug(`OpenBao ${operationName} error body: ${bodyText}`);
      throw new InternalException(
        errorCode,
        `OpenBao returned ${response.status} ${response.statusText}`,
      );
    }

    return response;
  }

  /**
   * Extract the KV v2 value from an OpenBao read response (shape
   * `{ data: { data: { value } } }`). Throws if the value is missing or not a
   * string. Shared by the project- and user-scoped getters.
   */
  private extractSecretValue(body: unknown, name: string): string {
    const value =
      body != null &&
      typeof body === 'object' &&
      'data' in body &&
      body.data != null &&
      typeof body.data === 'object' &&
      'data' in body.data &&
      body.data.data != null &&
      typeof body.data.data === 'object' &&
      'value' in body.data.data
        ? (body.data.data as Record<string, unknown>)['value']
        : undefined;
    if (typeof value !== 'string') {
      throw new InternalException(
        'SECRETS_STORE_GET_FAILED',
        `Unexpected response from OpenBao for secret "${name}"`,
      );
    }
    return value;
  }

  /**
   * Write a secret value to the KV v2 store at
   * `secret/data/projects/{projectId}/{secretName}`.
   */
  async putSecret(
    projectId: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.assertAvailable();
    await this.request(
      this.buildDataPath(projectId, name),
      { method: 'PUT', body: JSON.stringify({ data: { value } }) },
      'SECRETS_STORE_PUT_FAILED',
      'putSecret',
    );
  }

  /**
   * Read a secret value from the KV v2 store at
   * `secret/data/projects/{projectId}/{secretName}`.
   * Returns the stored string value.
   */
  async getSecret(projectId: string, name: string): Promise<string> {
    this.assertAvailable();
    const response = await this.request(
      this.buildDataPath(projectId, name),
      { method: 'GET' },
      'SECRETS_STORE_GET_FAILED',
      'getSecret',
    );
    return this.extractSecretValue(await response.json(), name);
  }

  /**
   * Delete a secret by removing its KV v2 metadata at
   * `secret/metadata/projects/{projectId}/{secretName}`.
   * Deleting metadata removes all versions of the secret.
   */
  async deleteSecret(projectId: string, name: string): Promise<void> {
    this.assertAvailable();
    await this.request(
      this.buildMetadataPath(projectId, name),
      { method: 'DELETE' },
      'SECRETS_STORE_DELETE_FAILED',
      'deleteSecret',
    );
  }

  /**
   * Write a user-scoped secret value to the KV v2 store at
   * `secret/data/users/{userId}/{secretName}`. Host-side per-user credential
   * storage (e.g. a per-user GitHub PAT) — never a project secret, and never
   * routed through the project secret picker / `collectSecretNames`.
   */
  async putUserSecret(
    userId: string,
    name: string,
    value: string,
  ): Promise<void> {
    this.assertAvailable();
    await this.request(
      this.buildUserDataPath(userId, name),
      { method: 'PUT', body: JSON.stringify({ data: { value } }) },
      'SECRETS_STORE_PUT_FAILED',
      'putUserSecret',
    );
  }

  /**
   * Read a user-scoped secret value from the KV v2 store at
   * `secret/data/users/{userId}/{secretName}`.
   */
  async getUserSecret(userId: string, name: string): Promise<string> {
    this.assertAvailable();
    const response = await this.request(
      this.buildUserDataPath(userId, name),
      { method: 'GET' },
      'SECRETS_STORE_GET_FAILED',
      'getUserSecret',
    );
    return this.extractSecretValue(await response.json(), name);
  }

  /**
   * Delete a user-scoped secret by removing its KV v2 metadata at
   * `secret/metadata/users/{userId}/{secretName}` (removes all versions).
   */
  async deleteUserSecret(userId: string, name: string): Promise<void> {
    this.assertAvailable();
    await this.request(
      this.buildUserMetadataPath(userId, name),
      { method: 'DELETE' },
      'SECRETS_STORE_DELETE_FAILED',
      'deleteUserSecret',
    );
  }
}
