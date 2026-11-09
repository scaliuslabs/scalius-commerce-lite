// Checkout order (Apps): at each checkout function point, the apps that take
// part in the order checkout runs them, how their answers combine (the
// first app wins a line, every app applies, discounts stack, changes
// follow one another) and, where the first app wins, which one does. Staff
// who manage apps reorder them with up and down buttons and save one
// point's order, or hand it back to the apps' own priorities. An app that is
// installed but not running keeps its place. Staff who only view see the
// order without the controls.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { appFunctionOrderMessages } from "~/i18n/app-function-order";
import { installedAppsMessages } from "~/i18n/apps";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { setAppFunctionOrder } from "~/lib/api-mutations/apps";
import { appFunctionOrderQueryOptions, type AppFunctionPointOrder } from "~/lib/api-query-options/apps";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { isKnownFunctionPoint } from "./app-functions";

type OrderedApp = AppFunctionPointOrder["apps"][number];

/** `ids` with the one at `index` swapped with its neighbour `by` places away. */
function moved(ids: readonly string[], index: number, by: -1 | 1): string[] {
  const next = [...ids];
  const other = index + by;
  if (other < 0 || other >= next.length) return next;
  [next[index], next[other]] = [next[other]!, next[index]!];
  return next;
}

interface PointSectionProps {
  order: AppFunctionPointOrder;
  canManage: boolean;
  busy: boolean;
  /** The save under way: its point, and whether it hands the order back to the apps. */
  saving: { point: string; reset: boolean } | null;
  /** The last save here lost to a newer order (another tab or merchant): the latest is shown. */
  conflict: boolean;
  onSave: (order: AppFunctionPointOrder, appIds: string[] | null) => void;
}

function PointSection({ order, canManage, busy, saving, conflict, onSave }: PointSectionProps) {
  const t = useMessages(appFunctionOrderMessages);
  const labels = useMessages(installedAppsMessages);
  const [draft, setDraft] = useState(() => order.apps.map((app) => app.id));
  const byId = new Map<string, OrderedApp>(order.apps.map((app) => [app.id, app]));
  const apps = draft.flatMap((id) => {
    const app = byId.get(id);
    return app ? [app] : [];
  });
  const dirty = draft.some((id, index) => id !== order.apps[index]?.id);
  // The first app that runs wins where the first answer wins; the preview follows the draft.
  const running = apps.filter((app) => app.runs);
  const winner = dirty ? (order.composition === "first" && running.length > 1 ? running[0]!.id : null) : order.winner;
  const reorderable = canManage && apps.length > 1;
  const headingId = `checkout-order-${order.point}`;
  const label = isKnownFunctionPoint(order.point) ? labels(`function_${order.point}`) : order.point;
  const here = saving?.point === order.point ? saving : null;

  return (
    <section data-point={order.point} aria-labelledby={headingId} className="border-t border-border">
      <div className="flex flex-col gap-1 px-4 pt-3 pb-2">
        <h3 id={headingId} className="text-body font-medium">{label}</h3>
        <p className="text-body text-muted-foreground">{t(`composition_${order.composition}`)}</p>
      </div>
      <ol>
        {apps.map((app, index) => (
          <li key={app.id} data-app={app.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
            <span className="w-6 shrink-0 text-body text-muted-foreground tabular-nums" aria-hidden="true">{t("position", { position: index + 1 })}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={app.runs ? "text-body font-medium wrap-anywhere" : "text-body font-medium text-muted-foreground wrap-anywhere"}>{app.name}</span>
                {winner === app.id ? <Badge variant="success">{t("winner")}</Badge> : null}
                {app.runs ? null : <Badge variant="secondary" title={t("notRunningHelp")}>{t("notRunning")}</Badge>}
                {app.blocking ? <Badge variant="warning" title={t("blockingHelp")}>{t("blocking")}</Badge> : null}
              </p>
              {order.ordered ? null : <p className="text-body text-muted-foreground">{t("ownPriority", { priority: app.priority })}</p>}
            </div>
            {reorderable ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy || index === 0}
                  aria-label={t("moveUp", { app: app.name })}
                  onClick={() => setDraft(moved(draft, index, -1))}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy || index === apps.length - 1}
                  aria-label={t("moveDown", { app: app.name })}
                  onClick={() => setDraft(moved(draft, index, 1))}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {conflict ? (
        <div className="px-4 pt-1">
          <Alert variant="warning" role="alert">
            <AlertDescription>{t("changed")}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-1 pb-3">
        {apps.length > 1 ? (
          <p className="me-auto text-body text-muted-foreground">{order.ordered ? t("ordered") : t("byPriority")}</p>
        ) : null}
        {reorderable ? (
          <>
            {order.ordered ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} loading={here?.reset === true} onClick={() => onSave(order, null)}>
                {t("reset")}
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={busy || !dirty} loading={here !== null && !here.reset} onClick={() => onSave(order, draft)}>
              {t("save")}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The checkout order of every function point apps implement. Renders nothing
 * for staff who cannot see Apps, or while no app implements a point.
 */
export function CheckoutOrderCard() {
  const t = useMessages(appFunctionOrderMessages);
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const queryClient = useQueryClient();
  const { data, isError, isRefetching, refetch } = useQuery({ ...appFunctionOrderQueryOptions(), enabled: canView });
  // The point whose last save lost to a newer order: it says so where the merchant is looking.
  const [conflictAt, setConflictAt] = useState<string | null>(null);
  const save = useMutation({
    // Each save names the order it started from, so a stale tab never replaces a newer one.
    mutationFn: ({ point, appIds, revision }: { point: AppFunctionPointOrder["point"]; appIds: string[] | null; revision: string }) =>
      setAppFunctionOrder(point, appIds, revision),
    onMutate: () => setConflictAt(null),
    onSuccess: (_saved, { appIds }) => {
      toast.success(appIds === null ? t("resetDone") : t("saved"));
    },
    onError: (error, { point }) => {
      if (error instanceof AdminApiResponseError && error.status === 409) setConflictAt(point);
      else toast.error(t("saveFailed"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.functionOrder() }),
  });

  if (!canView) return null;
  if (isError && !data) {
    return (
      <Card data-slot="checkout-order">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4">
          <p className="text-body text-destructive">{t("loadFailed")}</p>
          <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>{t("tryAgain")}</Button>
        </div>
      </Card>
    );
  }
  if (!data || data.length === 0) return null;

  return (
    <Card data-slot="checkout-order" className="overflow-clip">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      {data.map((order) => (
        <PointSection
          // The draft starts again from the server's order whenever it changes.
          key={`${order.point}:${order.revision}`}
          order={order}
          canManage={canManage}
          busy={save.isPending}
          saving={save.isPending ? { point: save.variables.point, reset: save.variables.appIds === null } : null}
          conflict={conflictAt === order.point}
          onSave={(current, appIds) => save.mutate({ point: current.point, appIds, revision: current.revision })}
        />
      ))}
    </Card>
  );
}
