// A checkout function whose answers kept failing has an open circuit
// (final audit I11): checkout stops calling it until `openUntil`, then tries
// it again. A function approved as blocking refuses orders meanwhile (the
// danger style); any other is skipped and checkout goes on (a warning).
// A function approved as blocking that keeps failing refuses every order
// that needs it: the page says since when, how (in the platform's words) and
// the app's last error from its log, and lets the merchant act without a
// developer: let checkout continue when it fails (after a confirmation naming
// the check; the function keeps running as an optional one) or pause the
// app. One that failed only once or twice gets a milder note. A point the
// store let checkout continue past is listed with the way back (Super Admin).
// An app whose cart rule refuses every recent checkout (a delivery-slot app
// with no open slot) answers fine, so its circuit stays closed: it gets its
// own danger alert, with the app's latest words to buyers.
import { useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { installedAppsMessages, type InstalledAppsMessageKey } from "~/i18n/apps";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { setAppFunctionBlocking, type AppFunctionPoint } from "~/lib/api-mutations/apps";
import { useCommand } from "~/lib/use-command";
import { toast } from "~/lib/toast";
import { formatWhen } from "../settings/webhooks/webhook-format";
import { useAppMutationResult } from "./AppDialogs";

type FailureKey = Extract<InstalledAppsMessageKey, `failure_${string}`>;
const FAILURE_KEYS: Record<string, FailureKey> = {
  threw: "failure_threw",
  timed_out: "failure_timed_out",
  invalid_answer: "failure_invalid_answer",
  call_refused: "failure_call_refused",
  could_not_run: "failure_could_not_run",
};

export function AppFunctionCircuits({ app, canManage = false, isSuperAdmin = false, onPause }: {
  app: Pick<AppDetail, "id" | "name" | "revision" | "status" | "functionCircuits" | "refusing" | "checkoutContinues">;
  canManage?: boolean;
  isSuperAdmin?: boolean;
  onPause?: () => void;
}) {
  const t = useMessages(installedAppsMessages);
  const [confirming, setConfirming] = useState<AppFunctionPoint | null>(null);
  const refusing = app.refusing ?? null;
  const failing = (refusing?.failing === true || refusing?.failedOnce === true) && refusing.point ? refusing : null;
  const continues = app.checkoutContinues ?? [];
  // A failing blocking function has its own alert, which says more than its circuit's.
  const open = (app.functionCircuits ?? []).filter((circuit) => circuit.open && circuit.point !== failing?.point);
  const result = useAppMutationResult(app);
  const blocking = useCommand({
    mutationFn: ({ point, block }: { point: AppFunctionPoint; block: boolean }) => setAppFunctionBlocking(app, point, block),
    onSuccess: ({ app: next }, { block }) => {
      result.applied(next, null, t(block ? "blockAgainDone" : "checkoutContinues", { app: app.name }));
      setConfirming(null);
    },
    onError: (error) => {
      if (!result.changed(error)) toast.error(t("checkoutContinueFailed"));
      setConfirming(null);
    },
  });
  if (open.length === 0 && !refusing && continues.length === 0) return null;
  const how = (failure: string | undefined) => t(FAILURE_KEYS[failure ?? ""] ?? "failure_unknown");
  return (
    <>
      {failing ? (
        <Alert variant={failing.failing ? "destructive" : "warning"} data-testid={failing.failing ? "app-failing-checkout" : "app-failed-once"}>
          {failing.failing ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <AlertDescription>
            <p>
              {failing.failing
                ? t("appFailing", { app: app.name, point: failing.point!, time: formatWhen(failing.since) ?? "—", how: how(failing.failure) })
                : t("appFailedOnce", { app: app.name, point: failing.point!, time: formatWhen(failing.lastAt) ?? "—", how: how(failing.failure) })}
            </p>
            {failing.lastError ? <p className="mt-1 break-words">{t("appFailingReason", { reason: failing.lastError })}</p> : null}
            {canManage && app.status === "active" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(failing.point as AppFunctionPoint)}>
                  {t("letCheckoutContinue")}
                </Button>
                {onPause ? <Button type="button" variant="outline" size="sm" onClick={onPause}>{t("pauseApp")}</Button> : null}
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : refusing ? (
        <Alert variant="destructive" data-testid="app-refusing-checkout">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            {refusing.reason
              ? t("appRefusing", { app: app.name, time: formatWhen(refusing.since) ?? "—", reason: refusing.reason })
              : t("appRefusingNoReason", { app: app.name, time: formatWhen(refusing.since) ?? "—" })}
          </AlertDescription>
        </Alert>
      ) : null}
      {continues.length > 0 ? (
        <Alert variant="info" data-testid="app-checkout-continues">
          <AlertTitle>{t("blockingOffTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("blockingOffBody", { points: continues.map((entry) => entry.point).join(", ") })}</p>
            {isSuperAdmin ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {continues.map((entry) => (
                  <Button key={entry.point} type="button" variant="outline" size="sm" loading={blocking.isPending}
                    onClick={() => blocking.mutate({ point: entry.point, block: true })}>
                    {continues.length > 1 ? `${t("blockAgain")} (${entry.point})` : t("blockAgain")}
                  </Button>
                ))}
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {open.map((circuit) => {
        const time = formatWhen(circuit.openUntil) ?? "—";
        // The function point as code, wherever the language puts it.
        const [before, after] = t(circuit.blocking ? "circuitBlocking" : "circuitPaused", { app: app.name, time, point: "\u0000" }).split("\u0000");
        return (
          <Alert key={circuit.point} variant={circuit.blocking ? "destructive" : "warning"}>
            {circuit.blocking ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
            <AlertDescription>
              {before}
              <code>{circuit.point}</code>
              {after}
            </AlertDescription>
          </Alert>
        );
      })}
      <AlertDialog open={confirming !== null} onOpenChange={blocking.guardClose((next: boolean) => { if (!next) setConfirming(null); })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("letCheckoutContinueTitle", { app: app.name, point: confirming ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("letCheckoutContinueBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={blocking.isPending}>{t("cancel")}</AlertDialogCancel>
            <Button type="button" variant="destructive" loading={blocking.isPending}
              onClick={() => confirming && blocking.mutate({ point: confirming, block: false })}>
              {t("letCheckoutContinue")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
