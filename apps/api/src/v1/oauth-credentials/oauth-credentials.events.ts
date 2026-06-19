import { OAuthProvider } from './oauth-credentials.types';

/**
 * EventEmitter2 event name for a completed OAuth exchange.
 *
 * `OAuthCredentialsService.exchange()` ALSO emits `credential.acquired` on the
 * `NotificationsService` subscriber bus (for WebSocket fan-out), but that bus is
 * DISJOINT from the NestJS EventEmitter2 bus that `@OnEvent` listens on — so a
 * `@OnEvent(CREDENTIAL_ACQUIRED_EVENT)` resume handler only fires because of the
 * explicit EventEmitter2 bridge emit added alongside the notification. This is
 * the load-bearing wiring that lets a paused run resume server-side once the
 * user authenticates (M3.3).
 */
export const CREDENTIAL_ACQUIRED_EVENT = 'credential.acquired';

export interface CredentialAcquiredEvent {
  projectId: string;
  provider: OAuthProvider;
  /**
   * The paused-run resume target — present when the acquisition came from an
   * `auth_required` capability link (the `threadId` threaded through OAuth
   * `start()` → pending-state → here). Absent for a plain in-editor auth, which
   * has no run to resume.
   */
  threadId?: string;
}
