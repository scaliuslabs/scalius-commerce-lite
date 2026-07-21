import { Link } from "@tanstack/react-router";
import {
  ArchiveRestore,
  Code2,
  Edit3,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { formatDate } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { AnalyticsScriptSummary } from "~/types/api-responses";
import {
  ANALYTICS_LOCATION_LABELS,
  ANALYTICS_PROVIDER_LABELS,
  ANALYTICS_PROVIDER_MARKS,
  analyticsReadinessPresentation,
} from "./analytics-list-presentation";
import { OfficialProviderMark } from "./settings/provider-marks";

interface AnalyticsMobileCardProps {
  script: AnalyticsScriptSummary;
  showTrashed: boolean;
  canEdit: boolean;
  canToggle: boolean;
  isMutating: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
}

export function AnalyticsMobileCard({
  script,
  showTrashed,
  canEdit,
  canToggle,
  isMutating,
  onActivate,
  onDeactivate,
  onTrash,
  onRestore,
  onPermanentDelete,
}: AnalyticsMobileCardProps) {
  const presentation = analyticsReadinessPresentation(script.readiness);
  const ReadinessIcon = presentation.icon;

  return (
    <article className="rounded-md border bg-card">
      <div className="flex min-w-0 items-start gap-2.5 p-3">
        {ANALYTICS_PROVIDER_MARKS[script.type] ? (
          <OfficialProviderMark provider={ANALYTICS_PROVIDER_MARKS[script.type]!} />
        ) : (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-muted/30">
            <Code2 aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{script.name}</h2>
            <Badge variant="outline" className={`h-6 shrink-0 gap-1 px-2 text-[11px] ${presentation.className}`}>
              <ReadinessIcon className="h-3 w-3" aria-hidden="true" />
              {presentation.label}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {ANALYTICS_PROVIDER_LABELS[script.type] ?? script.type}
            {script.identifier ? <span className="font-mono"> · {script.identifier}</span> : null}
          </p>
          {script.configIssue ? (
            <p className="mt-1.5 text-xs leading-4 text-destructive" role="status">
              {script.configIssue}
            </p>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-3 border-y bg-muted/10 px-3 py-2 text-[11px]">
        <div className="min-w-0 border-r pr-2">
          <dt className="text-muted-foreground">Placement</dt>
          <dd className="mt-0.5 truncate font-medium">{ANALYTICS_LOCATION_LABELS[script.location] ?? script.location}</dd>
        </div>
        <div className="min-w-0 border-r px-2">
          <dt className="text-muted-foreground">Execution</dt>
          <dd className="mt-0.5 truncate font-medium">{script.usePartytown ? "Worker" : "Main thread"}</dd>
        </div>
        <div className="min-w-0 pl-2">
          <dt className="text-muted-foreground">Updated</dt>
          <dd className="mt-0.5 truncate font-medium" suppressHydrationWarning>{formatDate(script.updatedAt)}</dd>
        </div>
      </dl>

      <footer className="flex flex-wrap justify-end gap-1 p-2">
        {showTrashed ? (
          canEdit ? (
            <>
              <Button type="button" variant="ghost" size="sm" className="h-11 px-3" disabled={isMutating} onClick={onRestore}>
                <ArchiveRestore />Restore
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-11 px-3 text-destructive hover:text-destructive" disabled={isMutating} onClick={onPermanentDelete}>
                <Trash2 />Delete permanently
              </Button>
            </>
          ) : null
        ) : (
          <>
            {canToggle && script.isActive ? (
              <Button type="button" variant="ghost" size="sm" className="h-11 px-3" disabled={isMutating} onClick={onDeactivate}>
                <PowerOff />Deactivate
              </Button>
            ) : null}
            {canToggle && !script.isActive && script.readiness === "ready_to_activate" ? (
              <Button type="button" variant="ghost" size="sm" className="h-11 px-3" disabled={isMutating} onClick={onActivate}>
                <Power />Activate
              </Button>
            ) : null}
            {canEdit ? (
              <Button variant="ghost" size="sm" className="h-11 px-3" asChild>
                <Link to="/admin/analytics/$analyticsId/edit" params={{ analyticsId: script.id }}>
                  <Edit3 />Edit
                </Link>
              </Button>
            ) : null}
            {canEdit ? (
              <Button type="button" variant="ghost" size="sm" className="h-11 px-3 text-destructive hover:text-destructive" disabled={isMutating} onClick={onTrash}>
                <Trash2 />Move to trash
              </Button>
            ) : null}
          </>
        )}
      </footer>
    </article>
  );
}
