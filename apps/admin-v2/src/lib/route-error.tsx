/**
 * Page-level error, not-found and no-access states: an icon, one heading,
 * one sentence and one action. Route error boundaries render them inside the
 * admin shell; the router's defaults render them full page when the shell
 * itself failed.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { CloudOff, FileQuestion, Lock, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { appMessages } from "~/i18n/app";
import {
  isRecoverableRouteLoadError,
  reloadRecoverableRouteOnce,
  RECOVERABLE_ROUTE_RELOAD_KEY,
} from "./recoverable-route-error";

export function PageState({
  icon: Icon,
  title,
  body,
  action,
  secondary,
  fullPage = false,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action: ReactNode;
  secondary?: ReactNode;
  fullPage?: boolean;
}) {
  const content = (
    <>
      <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Icon aria-hidden="true" className="size-6" />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h1 className="text-heading-lg">{title}</h1>
        <p className="text-body text-muted-foreground">{body}</p>
      </div>
      <div className="flex flex-col items-center gap-2">
        {action}
        {secondary}
      </div>
    </>
  );
  // Inside the shell the page already sits in its <main>.
  return fullPage ? (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-4 py-20 text-center text-foreground">
      {content}
    </main>
  ) : (
    <div className="flex flex-col items-center justify-center gap-4 px-4 py-20 text-center">{content}</div>
  );
}

/** "Go to Home": the one way out of a page that doesn't exist or isn't yours. */
export function NotFoundState({ fullPage = false, forbidden = false }: { fullPage?: boolean; forbidden?: boolean }) {
  const t = useMessages(appMessages);
  return (
    <PageState
      fullPage={fullPage}
      icon={forbidden ? Lock : FileQuestion}
      title={t(forbidden ? "forbiddenTitle" : "notFoundTitle")}
      body={t(forbidden ? "forbiddenBody" : "notFoundBody")}
      action={
        <Button asChild>
          <Link to="/admin">{t("goHome")}</Link>
        </Button>
      }
    />
  );
}

/**
 * Copies what support needs to find the fault: the error's name and message,
 * the page path (never its query) and the time. No stack trace on screen.
 */
function CopyDetailsButton({ error }: { error: Error }) {
  const t = useMessages(appMessages);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const details = [`${error.name}: ${error.message}`, window.location.pathname, new Date().toISOString()].join("\n");
    void navigator.clipboard?.writeText(details).then(() => setCopied(true), () => undefined);
  };
  return (
    <Button variant="ghost" size="sm" onClick={copy}>
      {copied ? t("copied") : t("copyDetails")}
    </Button>
  );
}

/** A page that failed to render or load: say so plainly, offer a retry, keep the details copyable. */
export function ErrorState({ error, onRetry, fullPage }: { error: Error; onRetry: () => void; fullPage?: boolean }) {
  const t = useMessages(appMessages);
  const offline = isConnectionError(error);
  return (
    <PageState
      fullPage={fullPage}
      icon={offline ? CloudOff : TriangleAlert}
      title={t(offline ? "offlineTitle" : "errorTitle")}
      body={t(offline ? "offlineBody" : "errorBody")}
      action={<Button onClick={onRetry}>{t("tryAgain")}</Button>}
      secondary={offline ? null : <CopyDetailsButton error={error} />}
    />
  );
}

function httpStatus(error: unknown): number | null {
  const status = typeof error === "object" && error !== null ? Number(Reflect.get(error, "status")) : NaN;
  return Number.isInteger(status) ? status : null;
}

/** The API or the network could not be reached (as opposed to a fault in the page). */
function isConnectionError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|load failed|networkerror|network request failed|session is unavailable/i.test(message);
}

export function RouteErrorComponent({
  error,
  reset,
  fullPage = false,
}: {
  error: Error;
  reset: () => void;
  fullPage?: boolean;
}) {
  const t = useMessages(appMessages);
  const router = useRouter();
  const updated = isRecoverableRouteLoadError(error);

  useEffect(() => {
    // A deploy replaced the bundle this tab was using: reload once by itself.
    if (!updated) return;
    reloadRecoverableRouteOnce({
      error,
      pathname: window.location.pathname,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  }, [error, updated]);

  if (updated) {
    const reload = () => {
      window.sessionStorage.removeItem(RECOVERABLE_ROUTE_RELOAD_KEY);
      window.location.reload();
    };
    return (
      <PageState
        fullPage={fullPage}
        icon={RefreshCw}
        title={t("updatedTitle")}
        body={t("updatedBody")}
        action={<Button onClick={reload}>{t("reload")}</Button>}
      />
    );
  }

  const status = httpStatus(error);
  if (status === 404 || status === 403) return <NotFoundState fullPage={fullPage} forbidden={status === 403} />;

  const retry = () => {
    reset();
    void router.invalidate();
  };
  return <ErrorState error={error} onRetry={retry} fullPage={fullPage} />;
}
