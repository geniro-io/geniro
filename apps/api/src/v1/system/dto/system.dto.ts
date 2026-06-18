import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SystemSettingsResponseSchema = z.object({
  githubAppEnabled: z
    .boolean()
    .describe('Whether the GitHub App integration is configured and available'),
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
