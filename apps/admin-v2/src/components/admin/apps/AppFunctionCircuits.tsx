// A checkout function whose answers kept failing has an open circuit
// (final audit I11): checkout stops calling it until `openUntil`, then tries
// it again. A function approved as blocking refuses orders meanwhile (the
// danger style); any other is skipped and checkout goes on (a warning).
// An app whose cart rule refuses every recent checkout (a delivery-slot app
// with no open slot) answers fine, so its circuit stays closed: it gets its
// own danger alert, with the app's latest words to buyers.
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { formatWhen } from "../settings/webhooks/webhook-format";

export function AppFunctionCircuits({ app }: { app: Pick<AppDetail, "name" | "functionCircuits" | "refusing"> }) {
  const t = useMessages(installedAppsMessages);
  const open = (app.functionCircuits ?? []).filter((circuit) => circuit.open);
  const refusing = app.refusing ?? null;
  if (open.length === 0 && !refusing) return null;
  return (
    <>
      {refusing ? (
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
