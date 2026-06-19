import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { OAuthProvider } from '../oauth-credentials.types';

export const OAuthProviderParamSchema = z.object({
  provider: z.nativeEnum(OAuthProvider),
});

export const OAuthStartQuerySchema = z.object({
  graphId: z.string().optional(),
  nodeId: z.string().optional(),
});

export const OAuthStartResponseSchema = z.object({
  authorizeUrl: z
    .string()
    .describe('Provider authorize URL to navigate the new tab to'),
});

export const OAuthStatusResponseSchema = z.object({
  provider: z.nativeEnum(OAuthProvider),
  authenticated: z
    .boolean()
    .describe('Whether a valid credential exists for this project + provider'),
  accountLabel: z.string().nullable(),
  secretName: z.string().nullable(),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .describe(
      'Access-token expiry as an ISO-8601 string; null when the token is non-expiring or no credential exists. Surfaced for the client pre-flight so it can warn ahead of expiry.',
    ),
});

export const OAuthExchangeRequestSchema = z.object({
  provider: z.nativeEnum(OAuthProvider),
  code: z.string().min(1),
  state: z.string().min(1),
});

export const OAuthExchangeResponseSchema = z.object({
  provider: z.nativeEnum(OAuthProvider),
  authenticated: z.literal(true),
  accountLabel: z.string(),
  secretName: z.string(),
});

export class OAuthProviderParamDto extends createZodDto(
  OAuthProviderParamSchema,
) {}
export class OAuthStartQueryDto extends createZodDto(OAuthStartQuerySchema) {}
export class OAuthStartResponseDto extends createZodDto(
  OAuthStartResponseSchema,
) {}
export class OAuthStatusResponseDto extends createZodDto(
  OAuthStatusResponseSchema,
) {}
export class OAuthExchangeRequestDto extends createZodDto(
  OAuthExchangeRequestSchema,
) {}
export class OAuthExchangeResponseDto extends createZodDto(
  OAuthExchangeResponseSchema,
) {}

export type OAuthStartResponse = z.infer<typeof OAuthStartResponseSchema>;
export type OAuthStatusResponse = z.infer<typeof OAuthStatusResponseSchema>;
export type OAuthExchangeRequest = z.infer<typeof OAuthExchangeRequestSchema>;
