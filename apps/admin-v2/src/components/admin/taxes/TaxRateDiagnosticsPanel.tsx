import { useMemo } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Layers3 } from "lucide-react";

import { EmptyState } from "~/components/admin/shell/EmptyState";
import { FormCard } from "~/components/admin/shell/FormCard";
import { StatusBadge, type StatusTone } from "~/components/admin/shell/StatusBadge";
import { Button } from "~/components/ui/button";
import type { TaxConfigurationPayload } from "~/lib/api-functions/taxes";
import {
  getTaxRateDiagnostics,
  type TaxClassCoverageDiagnostic,
} from "./tax-rate-diagnostics";

const coverageLabels = {
  all: "All destinations",
  scoped: "Selected only",
  none: "No active rate",
  exempt: "Exempt",
} as const;

const coverageTones: Record<TaxClassCoverageDiagnostic["state"], StatusTone> = {
  all: "success",
  exempt: "success",
  scoped: "attention",
  none: "attention",
};

export function TaxRateDiagnosticsPanel({
  configuration,
  canManage,
  onAddBroadRate,
  onOpenClasses,
  onReviewRate,
  onOpenPreview,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  onAddBroadRate: (classId: string) => void;
  onOpenClasses: () => void;
  onReviewRate: (rateId: string) => void;
  onOpenPreview: () => void;
}) {
  const diagnostics = useMemo(
    () => getTaxRateDiagnostics(configuration),
    [configuration],
  );
  const needsCoverage = diagnostics.coverage.filter((item) => item.needsBroadRate).length;

  return (
    <FormCard
      title="Coverage check"
      description="Find destinations with zero tax and rates that are added together."
      actions={(
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={needsCoverage > 0 ? "attention" : "success"}
            srLabel="Coverage:"
          >
            {diagnostics.coverage.length === 0
              ? "No tax classes"
              : needsCoverage > 0
                ? `${needsCoverage} coverage ${needsCoverage === 1 ? "gap" : "gaps"}`
                : "Coverage reviewed"}
          </StatusBadge>
          <StatusBadge
            tone={diagnostics.overlapCount > 0 ? "attention" : "neutral"}
            srLabel="Stacking:"
          >
            {diagnostics.overlapCount > 0
              ? `${diagnostics.overlapCount} stacking ${diagnostics.overlapCount === 1 ? "case" : "cases"}`
              : "No stacking found"}
          </StatusBadge>
        </div>
      )}
      footer={(
        <span>
          Use only rates verified for your business. This check explains saved
          calculation behavior; it does not determine legal obligations.
        </span>
      )}
    >
      <div className="@container space-y-4">
        {/* Two columns only once this card is really wide enough for them —
            beside the settings navigation the page itself is ~560px. */}
        {diagnostics.coverage.length > 0 ? (
          <ul className="grid gap-2 @2xl:grid-cols-2">
            {diagnostics.coverage.map((item) => (
              <li
                key={item.classId}
                className="flex min-w-0 flex-wrap items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 basis-[12rem]">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-pretty break-words">{item.className}</p>
                    <StatusBadge tone={coverageTones[item.state]} srLabel="Coverage:">
                      {coverageLabels[item.state]}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                </div>
                {item.needsBroadRate ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0 px-3 text-xs sm:min-h-8 sm:px-2"
                    disabled={!canManage}
                    aria-label={`Add all-destination rate for ${item.className}`}
                    onClick={() => onAddBroadRate(item.classId)}
                  >
                    Add broad rate
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={Layers3}
            compact
            heading="No tax classes yet"
            body="Create a class before adding destination rates."
            action={{
              label: "Create a class",
              variant: "outline",
              onClick: onOpenClasses,
              disabled: !canManage,
            }}
          />
        )}

        {diagnostics.overlaps.length > 0 ? (
          <div className="space-y-2" aria-label="Rate stacking checks">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Rates added together
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 gap-1 px-2 text-xs sm:min-h-8"
                onClick={onOpenPreview}
              >
                Test a destination <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            {diagnostics.overlaps.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-start gap-2.5 rounded-lg border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 basis-[12rem]">
                  <p className="text-sm font-medium text-pretty break-words">{item.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-amber-900/80 dark:text-amber-100/75">
                    {item.detail}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 shrink-0 px-3 text-xs hover:bg-amber-100 sm:min-h-8 sm:px-2 dark:hover:bg-amber-900/50"
                  disabled={!canManage || item.rateIds.length === 0}
                  onClick={() => item.rateIds[0] && onReviewRate(item.rateIds[0])}
                >
                  Review rate
                </Button>
              </div>
            ))}
            {diagnostics.hiddenOverlapCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {diagnostics.hiddenOverlapCount} more stacking{" "}
                {diagnostics.hiddenOverlapCount === 1 ? "case is" : "cases are"} present.
                Test affected destinations or simplify the saved rates.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            No active rates are added together by the saved class and destination rules.
          </p>
        )}
      </div>
    </FormCard>
  );
}
