import React, { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { formatUsd } from '../../chats/utils/chatsPageUtils';
import { parseFixture } from './fixture-schema';
import threeSubagentBatchRaw from './fixtures/three-subagent-batch.json';
import threeToolCallSubagentsRaw from './fixtures/three-tool-call-subagents.json';
import { StorybookChatsHarness } from './StorybookChatsHarness';
import type {
  LoadedFixture,
  ProgressSnapshot,
  SpeedMultiplier,
} from './ws-replay.types';
import { WSEventPlayer } from './WSEventPlayer';

/* -------------------------------------------------------------------------- */
/*  Fixture registry — import and validate at module load time                */
/* -------------------------------------------------------------------------- */

const THREE_SUBAGENT_BATCH = parseFixture(
  threeSubagentBatchRaw,
  'three-subagent-batch.json',
);

const THREE_TOOL_CALL_SUBAGENTS = parseFixture(
  threeToolCallSubagentsRaw,
  'three-tool-call-subagents.json',
);

const FIXTURE_MAP: Record<string, LoadedFixture> = {
  'three-subagent-batch': THREE_SUBAGENT_BATCH,
  'three-tool-call-subagents': THREE_TOOL_CALL_SUBAGENTS,
};

const SPEED_OPTIONS: SpeedMultiplier[] = [0.25, 0.5, 1, 2, 4];

/* -------------------------------------------------------------------------- */
/*  Layout helpers — mirrors page.tsx Section / Row (not exported there)      */
/* -------------------------------------------------------------------------- */

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-6 px-5 py-4">
      <div className="w-36 flex-shrink-0 pt-0.5">
        <p className="text-xs font-medium text-foreground">{label}</p>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-2.5">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  WSReplayHarnessSection                                                     */
/* -------------------------------------------------------------------------- */

export function WSReplayHarnessSection() {
  const [fixtureKey, setFixtureKey] = useState<string>('three-subagent-batch');
  const [progress, setProgress] = useState<ProgressSnapshot>({
    index: 0,
    total: 0,
    isRunning: false,
    lastEmittedAt: null,
  });
  const [resetToken, setResetToken] = useState<number>(0);
  const [speed, setSpeed] = useState<SpeedMultiplier>(1);
  const [aggregate, setAggregate] = useState<number | undefined>(undefined);

  const fixture = FIXTURE_MAP[fixtureKey];
  const playerRef = useRef<WSEventPlayer | null>(null);

  useEffect(() => {
    if (!fixture) {
      return;
    }
    const player = new WSEventPlayer(fixture, (snap) => {
      setProgress(snap);
    });
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [fixture]);

  const handlePlay = () => {
    playerRef.current?.play();
  };

  const handlePause = () => {
    playerRef.current?.pause();
  };

  const handleStep = () => {
    playerRef.current?.step();
  };

  const handleReset = () => {
    playerRef.current?.reset();
    setResetToken((t) => t + 1);
    setAggregate(undefined);
  };

  const handleSpeedChange = (value: string) => {
    const s = Number(value) as SpeedMultiplier;
    setSpeed(s);
    playerRef.current?.setSpeed(s);
  };

  const handleFixtureChange = (value: string) => {
    setFixtureKey(value);
    setResetToken((t) => t + 1);
    setAggregate(undefined);
  };

  return (
    <Section
      id="ws-replay-harness"
      title="WS Replay Harness"
      description="Replay recorded WebSocket event sequences through the production useChatsWebSocket + useChatsUsageStats + ThreadMessagesView reducer path. Reproduces intermittent cost-display regressions in isolation without a live backend.">
      <Row label="Controls">
        <Button size="sm" onClick={handlePlay}>
          Play
        </Button>
        <Button size="sm" variant="outline" onClick={handlePause}>
          Pause
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleStep}
          disabled={progress.isRunning}>
          Step
        </Button>
        <Button size="sm" variant="destructive" onClick={handleReset}>
          Reset
        </Button>
        <Select value={String(speed)} onValueChange={handleSpeedChange}>
          <SelectTrigger size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEED_OPTIONS.map((val) => (
              <SelectItem key={val} value={String(val)}>
                {val}x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={fixtureKey} onValueChange={handleFixtureChange}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="three-subagent-batch">
              three-subagent-batch
            </SelectItem>
            <SelectItem value="three-tool-call-subagents">
              Three tool-call subagents (live in-flight)
            </SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Playback state">
        <div className="flex items-center gap-2">
          <Badge variant={progress.isRunning ? 'default' : 'secondary'}>
            {progress.isRunning ? 'running' : 'paused'}
          </Badge>
          <span className="tabular-nums text-xs text-muted-foreground">
            Event {progress.index} / {progress.total}
          </span>
          <span className="tabular-nums text-sm font-medium">
            {formatUsd(aggregate)}
          </span>
        </div>
      </Row>
      <Row label="Rendered thread">
        {fixture && (
          <StorybookChatsHarness
            key={resetToken}
            fixture={fixture}
            resetToken={resetToken}
            onAggregateUsageChange={setAggregate}
          />
        )}
      </Row>
    </Section>
  );
}
