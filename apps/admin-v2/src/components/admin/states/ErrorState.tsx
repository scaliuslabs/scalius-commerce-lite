import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CloudOff, RefreshCw, ServerCrash, TriangleAlert } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { statesMessages } from "~/i18n/states";
import { readAdminApiError } from "~/lib/admin-api-error";
import { classifyFailure, retriesWhenOnline, type FailureKind } from "./failure";
import { useRetryWhenOnline } from "./online-status";
import { InlineError } from "./InlineError";
import { StateBlock, type StateIcon } from "./StateBlock";

const ICONS: Record<FailureKind, StateIcon> = {
  offline: CloudOff,
  unreachable: CloudOff,
  unavailable: ServerCrash,
  updated: RefreshCw,
  notFound: TriangleAlert,
  forbidden: TriangleAlert,
  broken: TriangleAlert,
};

type Reason = "reason.offline" | "reason.unreachable" | "reason.unavailable" | "reason.broken";
const REASONS: Partial<Record<FailureKind, Reason>> = {
  offline: "reason.offline",
  unreachable: "reason.unreachable",
  unavailable: "reason.unavailable",
};

export interface ErrorStateProps {
  /** The failure, for its kind (offline, server down, a fault). */
  error?: unknown;
  /** Overrides the kind read from `error`. */
  kind?: FailureKind;
  /** What failed, as a phrase in the sentence: "orders" gives "Couldn't load orders". */
  what?: string;
  /** Overrides the title. */
  title?: string;
  /** Overrides the sentence under the title. */
  description?: string;
  /** Read again. A page-level error also runs it when the connection comes back. */
  onRetry?: () => void;
  /** Where to go instead: "Back to orders". */
  backTo?: { to: string; label: string };
  /**
   * - `page`: the read the whole page stands on failed. The page title stays as
   *   the h1 (pass `pageTitle`), the failure sits in one card under it, and
   *   Retry is the page's one primary action.
   * - `card`: inside a card or table that failed (the list's rows).
   * - `inline`: one line with Retry, for one card of several (partial data, R3).
   */
  layout?: "page" | "card" | "inline";
  pageTitle?: string;
}

/**
 * The one view of a failed read (polish bar R1, R3): what failed, why when
 * known, Retry, and where to go. Never "Nothing changed": a read changes
 * nothing. A deploy that replaced this tab's code offers Reload instead.
 */
export function ErrorState({
  error,
  kind: kindProp,
  what,
  title,
  description,
  onRetry,
  backTo,
  layout = "card",
  pageTitle,
}: ErrorStateProps) {
  const t = useMessages(statesMessages);
  const kind = kindProp ?? classifyFailure(error);
  // A failed page re-runs its loaders on reconnect; card and inline reads are
  // refetched by the shell's reconnect (useOfflineNavigation).
  useRetryWhenOnline(onRetry, layout === "page" && Boolean(onRetry) && retriesWhenOnline(kind));

  const heading = title
    ?? (kind === "updated" ? t("updatedTitle")
      : what ? t("loadTitle", { what })
        : layout === "page" ? t("pageTitle") : t("sectionTitle"));
  // A refusal (4xx) carries its own reason ("This order is being edited by Rahim").
  const status = readAdminApiError(error)?.status ?? 0;
  const refusal = status >= 400 && status < 500 && error instanceof Error && error.message ? error.message : null;
  const reason = description
    ?? (kind === "updated" ? t("updatedBody") : refusal ?? t(REASONS[kind] ?? "reason.broken"));

  if (layout === "inline") {
    return <InlineError title={heading} kind={kind} description={reason} onRetry={onRetry} />;
  }

  const primary = layout === "page";
  const actions: ReactNode = (
    <>
      {backTo ? (
        <Button asChild variant="outline">
          <Link to={backTo.to}>{backTo.label}</Link>
        </Button>
      ) : null}
      {kind === "updated" ? (
        <Button type="button" variant={primary ? "default" : "outline"} onClick={() => window.location.reload()}>{t("reload")}</Button>
      ) : onRetry ? (
        <Button type="button" variant={primary ? "default" : "outline"} onClick={onRetry}>{t("retry")}</Button>
      ) : null}
    </>
  );
  const block = (
    <StateBlock
      icon={ICONS[kind]}
      title={heading}
      titleAs={layout === "page" && !pageTitle ? "h1" : "h2"}
      description={reason}
      actions={actions}
      footer={kind === "broken" && error instanceof Error ? <CopyDetailsButton error={error} /> : null}
    />
  );

  if (layout === "card") {
    return <div data-slot="error-state" data-state-kind={kind} role="alert">{block}</div>;
  }
  return (
    <div data-slot="error-state" data-state-kind={kind} role="alert" className="flex flex-col gap-4">
      {pageTitle ? <h1 className="text-heading-lg">{pageTitle}</h1> : null}
      <Card>{block}</Card>
    </div>
  );
}

/**
 * Copies what support needs to find the fault: the error's name and message,
 * the page path (never its query) and the time. No stack trace on screen.
 */
function CopyDetailsButton({ error }: { error: Error }) {
  const t = useMessages(statesMessages);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const details = [`${error.name}: ${error.message}`, window.location.pathname, new Date().toISOString()].join("\n");
    void navigator.clipboard?.writeText(details).then(() => setCopied(true), () => undefined);
  };
  return (
    <Button type="button" variant="ghost" onClick={copy}>
      {copied ? t("copied") : t("copyDetails")}
    </Button>
  );
}
