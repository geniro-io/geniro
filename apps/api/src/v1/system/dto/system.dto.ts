import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { GitHubAuthMethod } from '../../graph-resources/graph-resources.types';

export const SystemSettingsResponseSchema = z.object({
  githubAppEnabled: z
    .boolean()
    .describe(
      'Whether the GitHub App is configured (all GITHUB_APP_* env vars set) — the literal App config, independent of the active auth mode',
    ),
  githubAuthMode: z
    .nativeEnum(GitHubAuthMethod)
    .describe(
      'Deployment-wide GitHub auth mode: "github_app" uses the GitHub App, "pat" uses a configured personal access token instead',
    ),
  githubAvailable: z
    .boolean()
    .describe(
      'Whether GitHub operations are available in this deployment — App configured (app mode) or a PAT configured (pat mode)',
    ),
  githubAppInstallable: z
    .boolean()
    .describe(
      'Whether the GitHub App install/authorize UI should be shown — true only in app mode with the App configured; false in pat mode (configured-but-not-installable)',
    ),
  litellmManagementEnabled: z
    .boolean()
    .describe(
      'Whether the LiteLLM model management UI is enabled for the frontend',
    ),
  isAdmin: z.boolean().describe('Whether the current user has the admin role'),
  githubWebhookEnabled: z
    .boolean()
    .describe(
      'Whether the GitHub webhook receiver is configured and available',
    ),
  apiVersion: z.string().describe('Current API server version'),
  webVersion: z.string().describe('Current web client version'),
});

export type SystemSettingsResponse = z.infer<
  typeof SystemSettingsResponseSchema
>;

export class SystemSettingsResponseDto extends createZodDto(
  SystemSettingsResponseSchema,
) {}

export enum AuthProviderType {
  Keycloak = 'keycloak',
  Zitadel = 'zitadel',
}

export const AuthConfigResponseSchema = z.object({
  provider: z.nativeEnum(AuthProviderType).describe('Active auth provider'),
  issuer: z.string().describe('Token issuer URL'),
  clientId: z.string().describe('OAuth client ID for the auth provider'),
});

export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

export class AuthConfigResponseDto extends createZodDto(
  AuthConfigResponseSchema,
) {}
