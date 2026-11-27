// A checkout function whose answers kept failing has an open circuit
// (final audit I11): checkout stops calling it until `openUntil`, then tries
// it again. A function approved as blocking refuses orders meanwhile (the
// danger style); any other is skipped and checkout goes on (a warning).
// A function approved as blocking that is failing at all refuses every order
// that needs it: the page says since when and the last error, and lets the
// merchant act without a developer: let checkout continue when it fails (the
// store withdraws its approval of that blocking; the function keeps running
// as an optional one) or pause the app.
// An app whose cart rule refuses every recent checkout (a delivery-slot app
// with no open slot) answers fine, so its circuit stays closed: it gets its
// own danger alert, with the app's latest words to buyers.
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { setAppFunctionBlocking, type AppFunctionPoint } from "~/lib/api-mutations/apps";
import { useCommand } from "~/lib/use-command";
import { toast } from "~/lib/toast";
import { formatWhen } from "../settings/webhooks/webhook-format";
import { useAppMutationResult } from "./AppDialogs";

export function AppFunctionCircuits({ app, canManage = false, onPause }: {
  app: Pick<AppDetail, "id" | "name" | "revision" | "status" | "functionCircuits" | "refusing">;
  canManage?: boolean;
  onPause?: () => void;
}) {
  const t = useMessages(installedAppsMessages);
  const refusing = app.refusing ?? null;
  const failing = refusing?.failing === true && refusing.point ? refusing : null;
  // A failing blocking function has its own alert, which says more than its circuit's.
  const open = (app.functionCircuits ?? []).filter((circuit) => circuit.open && circuit.point !== failing?.point);
  const result = useAppMutationResult(app);
  const continueCheckout = useCommand({
    mutationFn: (point: AppFunctionPoint) => setAppFunctionBlocking(app, point, false),
    onSuccess: ({ app: next }) => result.applied(next, null, t("checkoutContinues", { app: app.name })),
    onError: (error) => {
      if (!result.changed(error)) toast.error(t("checkoutContinueFailed"));
    },
  });
  if (open.length === 0 && !refusing) return null;
  return (
    <>
      {failing ? (
        <Alert variant="destructive" data-testid="app-failing-checkout">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            <p>{t("appFailing", { app: app.name, point: failing.point!, time: formatWhen(failing.since) ?? "—" })}</p>
            {failing.reason ? <p className="mt-1 break-words">{t("appFailingReason", { reason: failing.reason })}</p> : null}
            {canManage && app.status === "active" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={continueCheckout.isPending}
                  onClick={() => continueCheckout.mutate(failing.point as AppFunctionPoint)}
                >
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
    </>
  );
}
