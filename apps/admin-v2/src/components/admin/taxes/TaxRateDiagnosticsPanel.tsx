import { useMemo } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleOff, Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TaxConfigurationPayload } from "@/lib/api-functions/taxes";
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

function CoverageIcon({ diagnostic }: { diagnostic: TaxClassCoverageDiagnostic }) {
  if (diagnostic.state === "all" || diagnostic.state === "exempt") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />;
  }
  return <CircleOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
}

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
    <Card>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Coverage check</CardTitle>
            <CardDescription className="mt-1">
              Find destinations with zero tax and rates that are added together.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={needsCoverage > 0 ? "outline" : "secondary"}>
              {diagnostics.coverage.length === 0
                ? "No tax classes"
                : needsCoverage > 0
                  ? `${needsCoverage} coverage ${needsCoverage === 1 ? "gap" : "gaps"}`
                  : "Coverage reviewed"}
            </Badge>
            <Badge variant={diagnostics.overlapCount > 0 ? "outline" : "secondary"}>
              {diagnostics.overlapCount > 0 ? `${diagnostics.overlapCount} stacking ${diagnostics.overlapCount === 1 ? "case" : "cases"}` : "No stacking found"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {diagnostics.coverage.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2">
            {diagnostics.coverage.map((item) => (
              <div key={item.classId} className="flex min-w-0 flex-wrap items-start gap-2.5 rounded-lg border px-3 py-2.5">
                <CoverageIcon diagnostic={item} />
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{item.className}</p>
                    <Badge variant="outline" className="font-normal">{coverageLabels[item.state]}</Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                </div>
                {item.needsBroadRate ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11 shrink-0 px-3 text-xs md:min-h-8 md:px-2"
                    disabled={!canManage}
                    aria-label={`Add all-destination rate for ${item.className}`}
                    onClick={() => onAddBroadRate(item.classId)}
                  >
                    Add broad rate
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3">
            <p className="text-sm text-muted-foreground">Create a tax class before adding destination rates.</p>
            <Button type="button" className="min-h-11 md:min-h-8" variant="outline" size="sm" disabled={!canManage} onClick={onOpenClasses}>Create a class</Button>
          </div>
        )}

        {diagnostics.overlaps.length > 0 ? (
          <div className="space-y-2" aria-label="Rate stacking checks">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rates added together</p>
              <Button type="button" variant="ghost" size="sm" className="min-h-11 gap-1 px-2 text-xs md:min-h-8" onClick={onOpenPreview}>
                Test a destination <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            {diagnostics.overlaps.map((item) => (
              <div key={item.id} className="flex flex-wrap items-start gap-2.5 rounded-lg border border-amber-300/70 bg-amber-50/60 px-3 py-2.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-amber-900/80 dark:text-amber-100/75">{item.detail}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 shrink-0 px-3 text-xs hover:bg-amber-100 md:min-h-8 md:px-2 dark:hover:bg-amber-900/50"
                  disabled={!canManage || item.rateIds.length === 0}
                  onClick={() => item.rateIds[0] && onReviewRate(item.rateIds[0])}
                >
                  Review rate
                </Button>
              </div>
            ))}
            {diagnostics.hiddenOverlapCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                {diagnostics.hiddenOverlapCount} more stacking {diagnostics.hiddenOverlapCount === 1 ? "case is" : "cases are"} present. Test affected destinations or simplify the saved rates.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            No active rates are added together by the saved class and destination rules.
          </div>
        )}

        <p className="flex items-start gap-2 border-t pt-3 text-xs leading-5 text-muted-foreground">
          <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Use only rates verified for your business. This check explains saved calculation behavior; it does not determine legal obligations.
        </p>
      </CardContent>
    </Card>
  );
}
