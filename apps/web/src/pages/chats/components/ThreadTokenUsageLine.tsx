import { AlertTriangle } from 'lucide-react';
import React from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../../components/ui/tooltip';
import type { ThreadTokenUsageSnapshot } from '../types';
import {
  clampPercent,
  formatCompactNumber,
  formatUsd,
} from '../utils/chatsPageUtils';
import { ContextUsageGauge } from './ContextUsageGauge';

type ThreadTokenUsageLineUsage = ThreadTokenUsageSnapshot & {
  effectiveCostLimitUsd?: number | null;
  stopReason?: string | null;
};

export const ThreadTokenUsageLine: React.FC<{
  usage?: ThreadTokenUsageLineUsage | null;
  withPopover?: boolean;
  contextMaxTokens?: number;
  contextPercent?: number;
  /** Sum of all in-flight subagent prices for the current run. When > 0 the
   *  cost is rendered as "$X.XX + $Y.YY in-flight". Pass 0 (or omit) when the
   *  thread is not running or there are no active subagent calls. */
  inFlightSum?: number;
}> = ({
  usage,
  withPopover = false,
  contextMaxTokens,
  contextPercent,
  inFlightSum = 0,
}) => {
  const totalTokens = usage?.totalTokens;
  // When inFlightSum is provided the caller has already folded it into
  // totalPrice (via selectedThreadAggregateUsage). baseTotalPrice is the
  // scalar portion excluding the in-flight contribution, used to split the
  // display into "$X.XX + $Y.YY in-flight".
  const totalPrice = usage?.totalPrice;
  const baseTotalPrice =
    inFlightSum > 0 && typeof totalPrice === 'number'
      ? totalPrice - inFlightSum
      : totalPrice;
  const currentContext = usage?.currentContext;
  const effectiveCostLimitUsd = usage?.effectiveCostLimitUsd;
  const stopReason = usage?.stopReason;
  if (typeof totalTokens !== 'number') {
    return null;
  }

  const percent =
    typeof contextPercent === 'number'
      ? contextPercent
      : typeof currentContext === 'number' &&
          typeof contextMaxTokens === 'number' &&
          Number.isFinite(contextMaxTokens) &&
          contextMaxTokens > 0
        ? (currentContext / contextMaxTokens) * 100
        : undefined;

  const hasLimit =
    typeof effectiveCostLimitUsd === 'number' &&
    Number.isFinite(effectiveCostLimitUsd);
  const costLimitReached = stopReason === 'cost_limit';
  const hasInFlight = inFlightSum > 0;

  const costText = hasLimit
    ? `${formatUsd(baseTotalPrice)} / ${formatUsd(effectiveCostLimitUsd)}`
    : hasInFlight
      ? `${formatUsd(baseTotalPrice)} + ${formatUsd(inFlightSum)} in-flight`
      : formatUsd(totalPrice);

  const labelText = `Token usage: ${formatCompactNumber(totalTokens)} (${costText})`;

  // H4: 14px bold qualifies as large text (WCAG AA threshold 3:1, met by
  // text-destructive). AlertTriangle ensures color is not the sole signal.
  const labelSpan = costLimitReached ? (
    <span
      className="text-sm font-semibold text-destructive inline-flex items-center gap-1"
      role="status">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {labelText} — Cost limit reached
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">{labelText}</span>
  );

  const labelNode = costLimitReached ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block cursor-help">{labelSpan}</span>
      </TooltipTrigger>
      <TooltipContent>Raise the limit to resume.</TooltipContent>
    </Tooltip>
  ) : (
    labelSpan
  );

  const line = (
    <span className="inline-flex items-center gap-2">
      {labelNode}
      {typeof percent === 'number' && <ContextUsageGauge percent={percent} />}
    </span>
  );

  if (!withPopover) {
    return line;
  }

  const fmt = (n?: number) =>
    typeof n === 'number' ? n.toLocaleString() : '\u2014';

  const popoverContent = (
    <div className="w-64 space-y-1">
      <p className="font-semibold text-foreground text-xs mb-2">Token Usage</p>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Input</span>
        <span className="font-medium text-foreground">
          {fmt(usage?.inputTokens)}
        </span>
      </div>
      {typeof usage?.cachedInputTokens === 'number' && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Cached input</span>
          <span className="font-medium text-foreground">
            {fmt(usage.cachedInputTokens)}
          </span>
        </div>
      )}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Output</span>
        <span className="font-medium text-foreground">
          {fmt(usage?.outputTokens)}
        </span>
      </div>
      {typeof usage?.reasoningTokens === 'number' &&
        usage.reasoningTokens > 0 && (
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Reasoning</span>
            <span className="font-medium text-foreground">
              {fmt(usage.reasoningTokens)}
            </span>
          </div>
        )}
      {typeof usage?.currentContext === 'number' && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Current context</span>
          <span className="font-medium text-foreground">
            {fmt(usage.currentContext)}
          </span>
        </div>
      )}
      <div className="border-t border-border my-1" />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Total</span>
        <span className="font-semibold text-foreground">
          {fmt(usage?.totalTokens)}
        </span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Cost</span>
        <span className="font-semibold text-foreground">
          {formatUsd(usage?.totalPrice)}
        </span>
      </div>
      {hasLimit && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Cost limit</span>
          <span className="font-semibold text-foreground">
            {formatUsd(effectiveCostLimitUsd)}
          </span>
        </div>
      )}
      {typeof percent === 'number' && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Context usage</span>
          <span className="font-medium text-foreground">
            {Math.round(clampPercent(percent))}%
            {typeof contextMaxTokens === 'number' &&
              Number.isFinite(contextMaxTokens) &&
              contextMaxTokens > 0 && (
                <> ({formatCompactNumber(contextMaxTokens)})</>
              )}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <span className="inline-block cursor-help">{line}</span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-auto p-3">
        {popoverContent}
      </PopoverContent>
    </Popover>
  );
};
