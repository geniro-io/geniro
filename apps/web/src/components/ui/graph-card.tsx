import { formatDistanceToNow } from 'date-fns';
import {
  Loader2,
  MessageCircle,
  Network,
  Pencil,
  Play,
  Square,
  Trash2,
} from 'lucide-react';

import { getStatusBadgeClass } from '../../utils/statusColors';
import { Badge } from './badge';
import { Button } from './button';
import { Card } from './card';

export interface GraphCardProps {
  name: string;
  status: string;
  version?: string | null;
  description?: string | null;
  nodeCount?: number;
  runningThreads?: number;
  totalThreads?: number;
  draftsCount?: number;
  updatedAt?: string | null;
  isToggling?: boolean;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleRun?: () => void;
}

export function GraphCard({
  name,
  status,
  version,
  description,
  nodeCount = 0,
  runningThreads = 0,
  totalThreads = 0,
  draftsCount = 0,
  updatedAt,
  isToggling = false,
  onClick,
  onEdit,
  onDelete,
  onToggleRun,
}: GraphCardProps) {
  const key = status.toLowerCase();
  const isRunning = key === 'running';
  // 'compiling' is an ACTIVE state in the backend registry: run() rejects with
  // GRAPH_ALREADY_RUNNING, but destroy() can cancel it. So the toggle must offer
  // "Stop" (cancel), never a "Run" that errors. A spinner signals it's busy.
  const isCompiling = key === 'compiling';
  const isActive = isRunning || isCompiling;

  return (
    <Card
      className="p-6 hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}>
      <div className="flex items-start justify-between">
        {/* Left: info */}
        <div className="flex-1 min-w-0 cursor-pointer">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="text-sm font-semibold hover:text-primary transition-colors">
              {name}
            </h3>
            <Badge
              variant={isRunning ? 'default' : 'secondary'}
              className={`text-[10px] px-1.5 py-0.5 font-medium ${getStatusBadgeClass(key)}`}>
              {key}
            </Badge>
            {version && (
              <span className="text-sm text-muted-foreground">{version}</span>
            )}
          </div>
          {description && (
            <p className="text-sm text-muted-foreground mb-3">{description}</p>
          )}
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <Network className="w-3.5 h-3.5 shrink-0" />
              {nodeCount} nodes
            </span>
            <span>&bull;</span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <MessageCircle className="w-3.5 h-3.5 shrink-0" />
              {totalThreads} threads
            </span>
            <span>&bull;</span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <MessageCircle className="w-3.5 h-3.5 shrink-0 text-blue-500" />
              {runningThreads} running
            </span>
            {draftsCount > 0 && (
              <>
                <span>&bull;</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                  {draftsCount} drafts
                </span>
              </>
            )}
          </div>
          {updatedAt && (
            <p className="text-xs text-muted-foreground mt-2">
              Modified{' '}
              {formatDistanceToNow(new Date(updatedAt), { addSuffix: true })}
            </p>
          )}
        </div>

        {/* Right: actions */}
        {(onToggleRun ?? onEdit ?? onDelete) && (
          <div
            className="flex items-center gap-2 ml-4 shrink-0"
            onClick={(e) => e.stopPropagation()}>
            {onToggleRun && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={isToggling}
                onClick={onToggleRun}>
                {isToggling || isCompiling ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isActive ? (
                  <Square className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                {isActive ? 'Stop' : 'Run'}
              </Button>
            )}
            {onEdit && (
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil className="w-4 h-4" />
              </Button>
            )}
            {onDelete && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
