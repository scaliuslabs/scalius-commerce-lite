// Settings › Webhooks (commerce hook H3): the store's webhook subscriptions,
// Shopify's Notifications › Webhooks. Each row shows where events go, which
// events, and whether deliveries are landing; its menu edits, tests, rotates
// the signing secret, turns it off or on, opens deliveries, or deletes it.
// Endpoints the API turned off after sustained failure get a banner on top.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, TriangleAlert } from "lucide-react";
import { toast } from "~/lib/toast";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { webhooksMessages } from "~/i18n/settings-webhooks";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { queryKeys } from "~/lib/query-keys";
import {
  deleteWebhook,
  rotateWebhookSecret,
  sendWebhookTest,
  updateWebhook,
  webhooksQueryOptions,
  type WebhookDelivery,
  type WebhookSubscription,
} from "~/lib/api-query-options/webhooks";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { DeliveryError } from "./DeliveryError";
import { WebhookDeliveriesSheet } from "./WebhookDeliveriesSheet";
import { WebhookFormDialog } from "./WebhookFormDialog";
import { WebhookSecretDialog } from "./WebhookSecretDialog";
import {
  formatDuration,
  formatWhen,
  hostOf,
  isDeliveryInFlight,
  subscriptionStatus,
  topicLabel,
} from "./webhook-format";

const VISIBLE_TOPICS = 3;

type TestResult = { state: "sending" } | { state: "done"; delivery: WebhookDelivery } | { state: "failed" };

function TopicChips({ topics }: { topics: string[] }) {
  const t = useMessages(webhooksMessages);
  const hidden = topics.length - VISIBLE_TOPICS;
  return (
    <div className="flex flex-wrap gap-1">
      {topics.slice(0, VISIBLE_TOPICS).map((topic) => (
        <Badge key={topic} variant="secondary">{topicLabel(topic)}</Badge>
      ))}
      {hidden > 0 ? (
        <Badge variant="outline" title={topics.slice(VISIBLE_TOPICS).map(topicLabel).join(", ")}>
          {t("moreTopics", { count: hidden })}
        </Badge>
      ) : null}
    </div>
  );
}

/** The last "Send test", under its row: delivered, failed (with why), or still on its way. */
function TestLine({ result }: { result: TestResult | undefined }) {
  const t = useMessages(webhooksMessages);
  if (!result) return null;
  if (result.state === "sending") {
    return (
      <p role="status" className="flex items-center gap-2 text-body text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("testSending")}
      </p>
    );
  }
  if (result.state === "failed") return <p role="status" className="text-body text-destructive">{t("testFailed")}</p>;
  const { delivery } = result;
  if (isDeliveryInFlight(delivery.status)) return <p role="status" className="text-body text-muted-foreground">{t("testQueued")}</p>;
  const ok = delivery.status === "succeeded";
  const facts = [
    // Status codes keep Latin digits, like IDs.
    delivery.responseStatus === null ? t("noResponse") : t("httpStatus", { code: String(delivery.responseStatus) }),
    formatDuration(delivery.durationMs),
  ].filter(Boolean);
  return (
    <div role="status" className="space-y-0.5 text-body">
      <p className={ok ? "text-success" : "text-destructive"}>
        {t(ok ? "testDelivered" : "testFailedResult")} · {facts.join(" · ")}
      </p>
      {!ok && delivery.error ? <DeliveryError error={delivery.error} /> : null}
    </div>
  );
}

function SubscriptionRow({
  subscription,
  canManage,
  test,
  onEdit,
  onTest,
  onRotate,
  onToggle,
  toggling,
  onDeliveries,
  onDelete,
}: {
  subscription: WebhookSubscription;
  canManage: boolean;
  test: TestResult | undefined;
  onEdit: () => void;
  onTest: () => void;
  onRotate: () => void;
  onToggle: () => void;
  toggling: boolean;
  onDeliveries: () => void;
  onDelete: () => void;
}) {
  const t = useMessages(webhooksMessages);
  const status = subscriptionStatus(subscription);
  const lastSuccess = formatWhen(subscription.lastSuccessAt);
  const streak = subscription.failureStreak;
  return (
    <li className="flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 max-w-full truncate font-mono text-body" title={subscription.url}>{subscription.url}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        {subscription.description ? <p className="break-words text-body">{subscription.description}</p> : null}
        <TopicChips topics={subscription.topics} />
        <p className="text-body text-muted-foreground">
          {lastSuccess ? t("lastSuccess", { date: lastSuccess }) : t("neverDelivered")}
          {streak > 0 ? (
            <>
              {" · "}
              <span className="text-warning">{streak === 1 ? t("failedOnce") : t("failedStreak", { count: streak })}</span>
            </>
          ) : null}
        </p>
        <TestLine result={test} />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={t("actionsFor", { url: hostOf(subscription.url) })}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canManage ? (
            <>
              <DropdownMenuItem onSelect={onEdit}>{t("edit")}</DropdownMenuItem>
              <DropdownMenuItem disabled={test?.state === "sending"} onSelect={onTest}>{t("sendTest")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={onRotate}>{t("rotateSecret")}</DropdownMenuItem>
              <DropdownMenuItem disabled={toggling} onSelect={onToggle}>
                {t(subscription.status === "active" ? "disable" : "enable")}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onSelect={onDeliveries}>{t("viewDeliveries")}</DropdownMenuItem>
          {canManage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>{t("delete")}</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Settings → Webhooks. Viewers see the list and deliveries; managers change them. */
export function WebhooksSettings() {
  const t = useMessages(webhooksMessages);
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.WEBHOOKS_VIEW);
  const canManage = hasPermission(ADMIN_PERMISSIONS.WEBHOOKS_MANAGE);
  const queryClient = useQueryClient();
  const { data, isError, refetch } = useQuery({ ...webhooksQueryOptions(), enabled: canView });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.all });

  const [form, setForm] = useState<{ open: boolean; subscription: WebhookSubscription | null }>({ open: false, subscription: null });
  // A new or rotated secret lives here only until "I've saved it".
  const [secret, setSecret] = useState<{ value: string; rotated: boolean } | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookSubscription | null>(null);
  const [rotating, setRotating] = useState<WebhookSubscription | null>(null);
  const [deleting, setDeleting] = useState<WebhookSubscription | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const rotate = useMutation({
    // The secret goes straight to component state; the mutation keeps nothing.
    mutationFn: async (subscription: WebhookSubscription) => {
      const result = await rotateWebhookSecret(subscription.id);
      setSecret({ value: result.secret, rotated: true });
    },
    onSuccess: () => setRotating(null),
    onError: () => void toast.error(t("rotateFailed")),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (subscription: WebhookSubscription) => deleteWebhook(subscription.id),
    onSuccess: () => {
      toast.success(t("deleted"));
      setDeleting(null);
    },
    onError: () => void toast.error(t("deleteFailed")),
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: (subscription: WebhookSubscription) =>
      updateWebhook(subscription.id, {
        expectedVersion: subscription.version,
        status: subscription.status === "active" ? "disabled" : "active",
      }),
    onSuccess: (updated) => void toast.success(t(updated.status === "active" ? "enabled" : "disabled")),
    onError: (error) => void toast.error(t(isAdminApiConflictError(error) ? "changedElsewhere" : "statusFailed")),
    onSettled: refresh,
  });

  async function sendTest(subscription: WebhookSubscription) {
    const id = subscription.id;
    setTests((current) => ({ ...current, [id]: { state: "sending" } }));
    try {
      const delivery = await sendWebhookTest(id);
      setTests((current) => ({ ...current, [id]: { state: "done", delivery } }));
    } catch {
      setTests((current) => ({ ...current, [id]: { state: "failed" } }));
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(id) });
  }

  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("title")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const { subscriptions, maxSubscriptions, apiVersion, topicFilters } = data;
  const failing = subscriptions.filter((subscription) => subscription.disabledReason === "failing");
  const atLimit = subscriptions.length >= maxSubscriptions;
  const openCreate = () => setForm({ open: true, subscription: null });
  const createButton = canManage ? (
    <Button type="button" size="sm" disabled={atLimit} onClick={openCreate}>{t("create")}</Button>
  ) : null;

  return (
    <>
      {failing.length > 0 ? (
        <Alert variant="warning" role="status">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{failing.length === 1 ? t("failingOne") : t("failingMany", { count: failing.length })}</AlertTitle>
          <AlertDescription>{t("failingBody")}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsCard
        id="webhooks"
        title={t("title")}
        description={t("description")}
        action={subscriptions.length > 0 ? createButton : null}
        rows={
          subscriptions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <div className="space-y-1">
                <p className="text-body font-medium">{t("emptyTitle")}</p>
                <p className="text-body text-muted-foreground">{t("emptyBody")}</p>
              </div>
              {createButton}
            </div>
          ) : (
            <>
              <ul>
                {subscriptions.map((subscription) => (
                  <SubscriptionRow
                    key={subscription.id}
                    subscription={subscription}
                    canManage={canManage}
                    test={tests[subscription.id]}
                    onEdit={() => setForm({ open: true, subscription })}
                    onTest={() => void sendTest(subscription)}
                    onRotate={() => setRotating(subscription)}
                    onToggle={() => toggle.mutate(subscription)}
                    toggling={toggle.isPending && toggle.variables?.id === subscription.id}
                    onDeliveries={() => setDeliveriesFor(subscription)}
                    onDelete={() => setDeleting(subscription)}
                  />
                ))}
              </ul>
              <p className="border-t border-border px-4 py-3 text-body text-muted-foreground">
                {canManage && atLimit
                  ? t("limitReached", { max: maxSubscriptions })
                  : t("usage", { count: subscriptions.length, max: maxSubscriptions, version: apiVersion })}
              </p>
            </>
          )
        }
      />
      <WebhookFormDialog
        open={form.open}
        onOpenChange={(open) => setForm((current) => ({ ...current, open }))}
        subscription={form.subscription}
        topicFilters={topicFilters}
        onCreated={(value) => setSecret({ value, rotated: false })}
      />
      <WebhookSecretDialog secret={secret?.value ?? null} rotated={secret?.rotated ?? false} onClose={() => setSecret(null)} />
      <WebhookDeliveriesSheet subscription={deliveriesFor} canManage={canManage} onClose={() => setDeliveriesFor(null)} />
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => (open ? undefined : setRotating(null))}
        title={t("rotateTitle", { host: rotating ? hostOf(rotating.url) : "" })}
        description={t("rotateBody")}
        confirmLabel={t("rotateSecret")}
        cancelLabel={t("cancel")}
        loadingLabel={t("working")}
        isLoading={rotate.isPending}
        onConfirm={() => (rotating ? rotate.mutate(rotating) : undefined)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={t("deleteTitle", { host: deleting ? hostOf(deleting.url) : "" })}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        loadingLabel={t("working")}
        isLoading={remove.isPending}
        onConfirm={() => (deleting ? remove.mutate(deleting) : undefined)}
      />
    </>
  );
}
