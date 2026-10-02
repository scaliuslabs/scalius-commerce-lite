// What an app surface shows when it isn't the app's tree: loading, a failed
// request (with Retry), and an answer the dashboard won't draw. Light on
// purpose (no UI schema): a card's crash fallback must never depend on the
// lazily loaded renderer.
import { CircleAlert, TriangleAlert } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";

function Lines() {
  const t = useMessages(appUiMessages);
  return (
    <div aria-busy="true" className="space-y-2">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
    </div>
  );
}

/** Mirrors the surface while its document loads (an app page keeps its real title). */
export function SurfaceSkeleton({ variant, title }: { variant: "page" | "embedded"; title?: string }) {
  if (variant === "embedded") return <Lines />;
  return (
    <>
      <PageHeader title={title ?? ""} />
      <Card>
        <CardContent className="pt-4">
          <Lines />
        </CardContent>
      </Card>
    </>
  );
}

/** The request failed: the reason (an app's masked one when the platform gave it) and Retry. */
export function SurfaceLoadError({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  const t = useMessages(appUiMessages);
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("loadFailedTitle")}</AlertTitle>
      <AlertDescription>
        <p className="break-words">{message}</p>
        <div className="pt-2">
          <Button type="button" variant="outline" size="sm" loading={retrying} onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** The app answered with something the dashboard won't draw: a newer UI version, or an invalid tree. */
export function UnreadableDocument({ reason, issues }: { reason: "version" | "invalid" | "too_large"; issues: Array<{ path: string; message: string }> }) {
  const t = useMessages(appUiMessages);
  if (reason === "version") {
    return (
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{t("versionTitle")}</AlertTitle>
        <AlertDescription>{t("versionBody")}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="warning">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{t("invalidTitle")}</AlertTitle>
      <AlertDescription>
        <p>{t("invalidBody")}</p>
        {issues.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-muted-foreground">{t("issueDetails")}</summary>
            <ul className="mt-1 space-y-0.5">
              {issues.map((issue, index) => (
                <li key={index} className="break-words">
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
