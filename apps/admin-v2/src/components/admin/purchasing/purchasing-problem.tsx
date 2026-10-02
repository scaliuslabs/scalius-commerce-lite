import { CircleAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";

/**
 * Why a purchasing write failed, so the banner offers what helps:
 * - stale: the document (or the stock) changed since it was loaded: reload;
 * - refused: the API said no and why (not enough units at the origin, an
 *   archived supplier, a line already received): its words, as they are;
 * - failed: no answer or a server fault: try again (a stock command's retry
 *   reuses its operation key, so it never counts twice).
 */
export type PurchasingProblem =
  | { kind: "stale" }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string };

export function readPurchasingProblem(error: unknown): PurchasingProblem {
  if (error instanceof AdminApiResponseError) {
    if (error.status === 409 && /\bchanged\b/i.test(error.message)) return { kind: "stale" };
    if (error.status >= 400 && error.status < 500 && error.status !== 401) {
      return { kind: "refused", message: getServerFnError(error) };
    }
  }
  return { kind: "failed", message: getServerFnError(error) };
}

/** A page banner for a purchasing write that didn't go through. */
export function PurchasingProblemBanner({
  problem,
  staleText,
  failedText,
  onReload,
  reloading = false,
}: {
  problem: PurchasingProblem | null;
  /** "This purchase order changed. Reload to see the latest." */
  staleText: string;
  /** What to do after a dropped connection or a server fault. */
  failedText: string;
  onReload?: () => void;
  reloading?: boolean;
}) {
  const t = useMessages(purchasingMessages);
  if (!problem) return null;
  if (problem.kind === "stale") {
    return (
      <Alert variant="warning">
        <TriangleAlert />
        <AlertDescription>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{staleText}</span>
            {onReload ? (
              <Button type="button" variant="outline" size="sm" loading={reloading} onClick={onReload}>{t("reload")}</Button>
            ) : null}
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{problem.kind === "refused" ? problem.message : failedText}</AlertDescription>
    </Alert>
  );
}
