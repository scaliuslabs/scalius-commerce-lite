import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsProvidersByIdTest,
  putApiV1AdminSettingsDeliveryProviders,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { apiData } from "~/lib/api";
import type { DeliveryProviderRecord } from "~/lib/api-query-options/delivery";
import {
  appProvidersQuery,
  areaCountsQuery,
  couriersQuery,
  platformQuery,
  type AppProvider,
} from "~/lib/api-query-options/settings-screens";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { getStoreRegion, useStoreDefaultsVersion } from "~/lib/store-time-zone";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { resolveProviderReadiness } from "../delivery-providers/provider-readiness";
import { AppIcon } from "../apps/AppIcon";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { AppProviderSetupButton, ProvidedByChip } from "./AppProviderStatus";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import { FieldRow } from "~/components/ui/field";

function refreshCheckout(queryClient: ReturnType<typeof useQueryClient>, key: readonly unknown[]) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: key }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
  ]);
}

// ── Delivery areas summary ─────────────────────────────────────────────

export function DeliveryAreasCard() {
  const t = useMessages(shippingMessages);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW);
  const { data, isError, refetch } = useQuery({ ...areaCountsQuery, enabled: canView });
  useStoreDefaultsVersion();
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadAreas")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  // Cities, thanas and areas are Bangladesh's: another country's store has none to manage.
  const bangladesh = getStoreRegion() === "BD";
  if (!bangladesh && data.cities + data.zones + data.areas === 0) return null;
  return (
    <SettingsCard id="deliveryAreas"
      title={t("areasTitle")}
      description={t(bangladesh ? "areasDescription" : "areasDescriptionGlobal")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/settings/shipping/areas">{t("manage")}</Link>
        </Button>
      }
    >
      <p className="text-body">{t(bangladesh ? "areasSummary" : "areasSummaryGlobal", data)}</p>
    </SettingsCard>
  );
}

// ── Couriers (delivery providers) ──────────────────────────────────────
// Every courier is an app's (`<plugin id>:<provider id>`: Pathao and
// Steadfast are the Bangladesh pack's). Its keys live in the app's settings;
// its readiness, mark and connection test come from GET/POST
// /admin/settings/providers. A row saved before the pack (`pathao`) shows the
// pack's reason until the pack is activated, which repoints it.

type ShippingCopy = ReturnType<typeof useMessages<keyof typeof shippingMessages.en>>;

/** Why an app courier can or can't book, in the merchant's language. */
function appCourierStatus(t: ShippingCopy, app: AppProvider): string {
  const vars = { app: app.appName };
  if (app.readiness.usable) return t("appCourierReady", vars);
  if (app.readiness.credentialErrors.length > 0) return t("appCourierUnreadable", vars);
  if (app.readiness.missingFields.length > 0) {
    return t("appCourierMissing", { ...vars, fields: app.readiness.missingFields.join(", ") });
  }
  return t("appCourierInactive", vars);
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const t = useMessages(shippingMessages);
  const [copied, setCopied] = useState(false);
  return (
    <SettingsField id={id} label={label}>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} />
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })}
        >
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    </SettingsField>
  );
}

/** The app couriers this screen can offer, readable only with the courier permissions. */
function useAppCouriers(): AppProvider[] {
  const { canView } = useProviderPortAccess("courier");
  return useQuery({ ...appProvidersQuery("courier"), enabled: canView }).data ?? [];
}

function CourierForm({ courier }: { courier: DeliveryProviderRecord | null }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const apiUrl = useQuery(platformQuery).data?.apiUrl ?? "";
  const { canManage: canTestApps } = useProviderPortAccess("courier");
  const appCouriers = useAppCouriers();
  const [saved] = useState(() => ({
    id: courier?.id ?? crypto.randomUUID(),
    name: courier?.name ?? "",
    type: courier?.type ?? appCouriers[0]?.id ?? "",
    isActive: courier?.isActive ?? false,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const courierId = courier && courier.type === draft.type ? courier.courierId : draft.type;
  const app = appCouriers.find((provider) => provider.id === courierId) ?? null;
  // A row saved before its app took it over (`pathao`) is repointed when the app is activated.
  const retired = Boolean(courier && courier.courierId !== courier.type);
  const blockedReason = courier?.readiness?.issues.find((issue) => issue.code !== "inactive")?.message;
  // A courier app is ready when the app says so; a saved one without the app's answer keeps the server's verdict.
  const blocked = retired || (app
    ? !app.readiness.usable
    : (courier?.type === draft.type ? courier.readiness?.activationBlockers?.length ?? 0 : 1) > 0);
  const courierLabel = app?.name ?? courier?.courierName ?? draft.type;
  const refresh = () => refreshCheckout(queryClient, queryKeys.settings.deliveryProviders());
  const save = useMutation({
    // A courier's row carries no keys: the app's settings hold them.
    mutationFn: () => apiData(putApiV1AdminSettingsDeliveryProviders({
      body: { id: draft.id, name: draft.name.trim(), type: draft.type, isActive: draft.isActive },
    })),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: async () => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: courierId } })),
    onSuccess: (result) => {
      if (result.ok) toast.success(t("testOk"));
      // The app's own answer is merchant-facing.
      else toast.error(t("appTestFailed", { app: app?.appName ?? courierLabel }), { description: result.message });
    },
    onError: () => toast.error(t("testFailed")),
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminSettingsDeliveryProvidersById({ path: { id: draft.id } })),
    onSuccess: async () => {
      toast.success(t("courierDeleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  useSaveBar({
    fields: { name: "courier-name" },
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    // Fail closed: a courier can't be switched on until its app can book.
    invalid: retired || !draft.name.trim() || !draft.type || (draft.isActive && blocked),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const typeOptions = [
    ...appCouriers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.appName })),
    // A saved courier whose app this screen can't list still names itself.
    ...(courier && !appCouriers.some((provider) => provider.id === courier.type) ? [{ value: courier.type, label: courier.courierName }] : []),
  ];

  return (
    <>
      <FieldRow>
        <SettingsField id="courier-name" label={t("courierName")}>
          <Input id="courier-name" value={draft.name} placeholder={courierLabel} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SettingsField>
        <SettingsField id="courier-type" label={t("courierType")} help={typeOptions.length === 0 ? t("noCourierApps") : undefined}>
          <SearchableSelect
            id="courier-type"
            value={draft.type}
            disabled={Boolean(courier)}
            onValueChange={(type) => setDraft({ ...draft, type })}
            triggerClassName="w-full"
            options={typeOptions}
          />
        </SettingsField>
      </FieldRow>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("courierOn")}</span>
          {blocked ? (
            <span className="block text-muted-foreground">
              {retired ? blockedReason ?? t("appCourierInactive", { app: courierLabel }) : app ? appCourierStatus(t, app) : t("appCourierInactive", { app: courierLabel })}
            </span>
          ) : null}
        </span>
        <Switch
          checked={draft.isActive}
          disabled={retired || (!draft.isActive && blocked)}
          onCheckedChange={(isActive) => setDraft({ ...draft, isActive })}
        />
      </label>
      {app ? <AppCourierFields app={app} apiUrl={apiUrl} courierLabel={courierLabel} /> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          loading={test.isPending}
          disabled={retired || !app?.canTestConnection || !canTestApps}
          onClick={() => test.mutate()}
        >
          {t("test")}
        </Button>
        {app && !app.canTestConnection ? <p className="text-body text-muted-foreground">{t("appCourierNoTest", { app: app.appName })}</p> : null}
        {courier ? (
          <>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
              {t("deleteCourier")}
            </Button>
            <ConfirmDialog
              open={confirmDelete}
              onOpenChange={setConfirmDelete}
              title={common("deleteNamed", { name: courier.name })}
              description={t("deleteCourierConfirm", { name: courier.name })}
              confirmLabel={common("delete")}
              cancelLabel={common("cancel")}
              isLoading={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

/** A courier app's keys: whether it can book, the button that opens its setup sheet, and its update link. */
function AppCourierFields({ app, apiUrl, courierLabel }: { app: AppProvider; apiUrl: string; courierLabel: string }) {
  const t = useMessages(shippingMessages);
  return (
    <>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-body">{t("appCourierSetup")}</p>
            <ProvidedByChip pluginId={app.pluginId} appName={app.appName} />
          </div>
          <p className="text-body text-muted-foreground">{appCourierStatus(t, app)}</p>
        </div>
        <AppProviderSetupButton provider={app} size="sm" />
      </div>
      {app.operations.includes("verifyWebhook") ? (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-body font-medium">{t("updatesTitle")}</p>
          <p className="text-body text-muted-foreground">{t("appCourierUpdatesHelp", { courier: courierLabel, app: app.appName })}</p>
          {apiUrl ? <CopyField id="courier-webhook-url" label={t("updatesUrl")} value={`${apiUrl}/api/v1/webhooks/couriers/${app.id}`} /> : null}
        </div>
      ) : null}
    </>
  );
}

export function CouriersCard() {
  const t = useMessages(shippingMessages);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT);
  const { data, isError, refetch } = useQuery({ ...couriersQuery, enabled: canView });
  const appCouriers = useAppCouriers();
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadCouriers")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="couriers"
      title={t("couriersTitle")}
      description={data.length ? t("couriersDescription") : t("noCouriers")}
      action={
        <SettingsDialog title={t("addCourier")} trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addCourier")}</Button>}>
          <CourierForm courier={null} />
        </SettingsDialog>
      }
      rows={data.length === 0 ? undefined : data.map((courier) => {
        const readiness = resolveProviderReadiness(courier);
        return (
          <SettingsDialog key={courier.id} title={courier.name} trigger={
            <SettingsRow
              disabled={!canEdit}
              label={
                <span className="flex items-center gap-2">
                  {/* The courier's own mark, from its app's listing. */}
                  <AppIcon src={appCouriers.find((provider) => provider.id === courier.courierId)?.icon} size="sm" />
                  {courier.name}
                </span>
              }
              value={readiness.canCreateShipment ? t("courierReady") : courier.isActive ? t("courierNeedsSetup") : t("courierOff")}
            />
          }>
            <CourierForm courier={courier} />
          </SettingsDialog>
        );
      })}
    />
  );
}
