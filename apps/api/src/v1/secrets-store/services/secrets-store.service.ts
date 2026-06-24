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
   * Read a user-scoped secret, distinguishing a CONFIRMED-ABSENT secret (the
   * store responded HTTP 404 — the path genuinely holds no value) from a
   * TRANSIENT failure (store not configured, 5xx, network error, timeout). This
   * split lets a credential resolver fail CLOSED on an absent-but-expected
   * secret (the credential is broken — surface it) while degrading gracefully
   * on a store blip (don't brick every user on a momentary outage). See
   * `GitUserPatService.resolvePatToken`.
   *
   * Returns `{ found: true, value }` on success and `{ found: false }` when the
   * credential is definitively unretrievable WITHOUT a store outage — a
   * confirmed 404 OR a 200 whose body carries no usable value (corrupt: partial
   * write / manual KV edit / shape mismatch). THROWS `InternalException` only on
   * a genuinely transient/unavailable condition (store not configured, 5xx,
   * network error, timeout) — the caller owns the fallback. The split lets a
   * resolver fail CLOSED on a broken-but-present credential (surface it) while
   * degrading gracefully on a momentary store blip. Never echoes the response
   * body (it can carry secret-derived detail).
   */
  async readUserSecret(
    userId: string,
    name: string,
  ): Promise<{ found: true; value: string } | { found: false }> {
    this.assertAvailable();
    let response: Response;
    try {
      response = await fetch(this.buildUserDataPath(userId, name), {
        method: 'GET',
        headers: this.authHeaders,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Network error or AbortError (timeout) — transient. Never echo the cause.
      throw new InternalException(
        'SECRETS_STORE_GET_FAILED',
        'Could not reach the secrets store.',
      );
    }

    if (response.status === 404) {
      return { found: false };
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.debug(`OpenBao readUserSecret error body: ${bodyText}`);
      throw new InternalException(
        'SECRETS_STORE_GET_FAILED',
        `OpenBao returned ${response.status} ${response.statusText}`,
      );
    }

    // A 200 whose body lacks a usable value is a CORRUPT secret (partial write /
    // manual KV edit / shape mismatch), NOT a transient outage — the store
    // answered 200. Map it to {found:false} so a credential resolver fails
    // CLOSED on it (exactly like a confirmed 404), instead of letting
    // extractSecretValue's throw propagate through the transient channel above
    // where the resolver would mask the broken credential as an App fallback.
    let value: string;
    try {
      value = this.extractSecretValue(await response.json(), name);
    } catch {
      return { found: false };
    }
    // An empty-string value is the same corruption class: extractSecretValue
    // accepts '' (it IS a string), but a zero-length credential is unusable and
    // is never written by the validated put* path. Left as {found:true,''} it
    // would reach a consumer as a falsy "no PAT" and silently degrade to the App
    // fallback — the exact masking this method's fail-closed contract prevents.
    if (value.length === 0) {
      return { found: false };
    }
    return { found: true, value };
  }

  /**
   * Read a user-scoped secret value from the KV v2 store at
   * `secret/data/users/{userId}/{secretName}`. Throws on any failure including a
   * confirmed-absent secret. Callers that must distinguish a transient store
   * failure from a genuinely-absent secret use {@link readUserSecret} instead.
   */
  async getUserSecret(userId: string, name: string): Promise<string> {
    const result = await this.readUserSecret(userId, name);
    if (!result.found) {
      throw new InternalException(
        'SECRETS_STORE_GET_FAILED',
        `Secret "${name}" not found in the secrets store.`,
      );
    }
    return result.value;
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
