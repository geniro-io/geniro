import type { SocketNotification } from '../../../services/WebSocketTypes';

export interface FixtureEvent {
  delayMs: number;
  event: SocketNotification;
}

export interface LoadedFixture {
  name: string;
  description: string;
  threadId: string;
  graphId: string;
  events: FixtureEvent[];
}

export type SpeedMultiplier = 0.25 | 0.5 | 1 | 2 | 4;

export interface ProgressSnapshot {
  index: number;
  total: number;
  isRunning: boolean;
  lastEmittedAt: number | null;
}

export type ProgressCallback = (snapshot: ProgressSnapshot) => void;
