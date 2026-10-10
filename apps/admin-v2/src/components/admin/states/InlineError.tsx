import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { readAdminApiError } from "~/lib/admin-api-error";
import { classifyFailure, type FailureKind } from "./failure";

const REASONS = {
  offline: "reason.offline",
  unreachable: "reason.unreachable",
  unavailable: "reason.unavailable",
} as const;

/**
 * One part of a page whose read failed (polish bar R3): one line that says
 * what failed and why, and Retry; the rest of the page still renders. Kept
 * apart from `ErrorState` so a card that only needs this line downloads
 * nothing more.
 */
export function InlineError({
  title,
  error,
  kind: kindProp,
  description,
  onRetry,
}: {
  /** What failed: "Couldn't load shipments". */
  title?: string;
  error?: unknown;
  kind?: FailureKind;
  description?: string;
  onRetry?: () => void;
}) {
  const t = useMessages(shellMessages);
  const kind = kindProp ?? classifyFailure(error);
  const status = readAdminApiError(error)?.status ?? 0;
  const refusal = status >= 400 && status < 500 && error instanceof Error && error.message ? error.message : null;
  const reason = description
    ?? (kind === "updated" ? t("updatedBody") : refusal ?? t(kind in REASONS ? REASONS[kind as keyof typeof REASONS] : "reason.broken"));
  return (
    <div data-slot="error-state" data-state-kind={kind} role="alert" className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 text-body text-muted-foreground">
        <span className="font-medium text-foreground">{title ?? t("sectionTitle")}</span> {reason}
      </p>
      {onRetry ? <Button type="button" variant="outline" onClick={onRetry}>{t("retry")}</Button> : null}
    </div>
  );
}
