import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsDeliveryProvidersCreateTest,
  postApiV1AdminSettingsProvidersByIdTest,
  putApiV1AdminSettingsDeliveryProviders,
} from "@scalius/api-client/sdk";
import { getDeliveryProviderActivationBlockers } from "@scalius/core/modules/delivery/browser";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiBody } from "~/lib/api";
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
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { ProviderIcon, resolveProviderReadiness } from "../delivery-providers/ProviderIcon";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED = "••••••••••••";

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
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadAreas")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  return (
    <SettingsCard id="deliveryAreas"
      title={t("areasTitle")}
      description={t("areasDescription")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/settings/shipping/areas">{t("manage")}</Link>
        </Button>
      }
    >
      <p className="text-body">{t("areasSummary", data)}</p>
    </SettingsCard>
  );
}

// ── Couriers (delivery providers) ──────────────────────────────────────
// Pathao and Steadfast keep their keys on the courier; an installed courier
// app (`<plugin id>:<provider id>`) keeps them in the app's settings, and its
// readiness and connection test come from GET/POST /admin/settings/providers.

type CourierType = "pathao" | "steadfast";
type Environment = "production" | "sandbox" | "custom";

function isBuiltIn(type: string): type is CourierType {
  return type === "pathao" || type === "steadfast";
}

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
const ENDPOINTS = {
  pathao: { production: "https://api-hermes.pathao.com", sandbox: "https://courier-api-sandbox.pathao.com" },
  steadfast: { production: "https://portal.packzy.com/api/v1" },
} as const;
const DEFAULTS: Record<CourierType, { credentials: Record<string, string>; config: Record<string, string | number> }> = {
  pathao: {
    // New couriers start on the test account; switch to Live once a test works.
    credentials: { baseUrl: ENDPOINTS.pathao.sandbox, clientId: "", clientSecret: "", username: "", password: "", webhookSecret: "" },
    config: { storeId: "", defaultDeliveryType: 48, defaultItemType: 2, defaultItemWeight: 0.5 },
  },
  steadfast: {
    credentials: { baseUrl: ENDPOINTS.steadfast.production, apiKey: "", secretKey: "", webhookSecret: "" },
    config: { defaultCodAmount: 0 },
  },
};
const SECRET_FIELDS: Record<CourierType, Array<{ key: string; label: "clientId" | "clientSecret" | "username" | "password" | "apiKey" | "secretKey"; secret: boolean }>> = {
  pathao: [
    { key: "clientId", label: "clientId", secret: false },
    { key: "clientSecret", label: "clientSecret", secret: true },
    { key: "username", label: "username", secret: false },
    { key: "password", label: "password", secret: true },
  ],
  steadfast: [
    { key: "apiKey", label: "apiKey", secret: true },
    { key: "secretKey", label: "secretKey", secret: true },
  ],
};

function parse(json: string | undefined): Record<string, string | number> {
  try {
    return JSON.parse(json ?? "{}") as Record<string, string | number>;
  } catch {
    return {};
  }
}

function environmentOf(type: CourierType, baseUrl: string): Environment {
  const url = baseUrl.trim().replace(/\/+$/u, "");
  if (url === ENDPOINTS[type].production) return "production";
  if (type === "pathao" && url === ENDPOINTS.pathao.sandbox) return "sandbox";
  return "custom";
}

function newWebhookKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function CourierForm({ courier }: { courier: DeliveryProviderRecord | null }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const apiUrl = useQuery(platformQuery).data?.apiUrl ?? "";
  const canReadApps = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW);
  const canTestApps = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const appCouriers = useQuery({ ...appProvidersQuery("courier"), enabled: canReadApps }).data ?? [];
  const [saved] = useState<CourierDraft & { id: string; name: string; type: string; isActive: boolean }>(() => {
    const type = courier?.type ?? "pathao";
    return {
      id: courier?.id ?? crypto.randomUUID(),
      name: courier?.name ?? "",
      type,
      isActive: courier?.isActive ?? false,
      credentials: courier ? parse(courier.credentials) : isBuiltIn(type) ? { ...DEFAULTS[type].credentials } : {},
      config: courier ? parse(courier.config) : isBuiltIn(type) ? { ...DEFAULTS[type].config } : {},
    };
  });
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const builtIn = isBuiltIn(draft.type) ? draft.type : null;
  const app = builtIn ? null : appCouriers.find((provider) => provider.id === draft.type) ?? null;
  // A courier app is ready when the app says so; a saved one without the app's answer keeps the server's verdict.
  const appBlocked = app
    ? !app.readiness.usable
    : (courier?.type === draft.type ? courier.readiness?.activationBlockers?.length ?? 0 : 1) > 0;
  const blocked = builtIn
    ? getDeliveryProviderActivationBlockers({ type: builtIn, credentials: draft.credentials, config: draft.config }).length > 0
    : appBlocked;
  const text = (value: string | number | undefined) => String(value ?? "");
  const setCredential = (key: string, value: string) =>
    setDraft((current) => ({ ...current, credentials: { ...current.credentials, [key]: value } }));
  const setConfig = (key: string, value: string | number) =>
    setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  const environment = builtIn ? environmentOf(builtIn, text(draft.credentials.baseUrl)) : "production";
  const setEnvironment = (next: Environment) =>
    setDraft((current) => {
      if (!isBuiltIn(current.type)) return current;
      return {
        ...current,
        // A different account never keeps the other account's keys.
        credentials: {
          ...DEFAULTS[current.type].credentials,
          webhookSecret: text(current.credentials.webhookSecret),
          baseUrl: next === "custom" ? "" : next === "sandbox" ? ENDPOINTS.pathao.sandbox : ENDPOINTS[current.type].production,
        },
        config: current.type === "pathao" ? { ...current.config, storeId: "" } : current.config,
      };
    });
  const refresh = () => refreshCheckout(queryClient, queryKeys.settings.deliveryProviders());
  const save = useMutation({
    mutationFn: () =>
      apiData(putApiV1AdminSettingsDeliveryProviders({
        // A courier app's row carries no keys: the app's settings hold them.
        body: (builtIn
          ? {
            id: draft.id,
            name: draft.name.trim(),
            type: draft.type,
            isActive: draft.isActive,
            credentials: JSON.stringify(draft.credentials),
            config: JSON.stringify(draft.config),
          }
          : { id: draft.id, name: draft.name.trim(), type: draft.type, isActive: draft.isActive }
        ) as ApiBody<typeof putApiV1AdminSettingsDeliveryProviders>,
      })),
    onSuccess: refresh,
  });
  // A saved courier tests its saved keys; a new one tests the keys typed so far; a courier app tests through the app.
  const test = useMutation({
    mutationFn: async (): Promise<{ success: boolean; message: string }> => {
      if (!builtIn) {
        const result = await apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: draft.type } }));
        return { success: result.ok, message: result.message };
      }
      return courier
        ? apiData(postApiV1AdminSettingsDeliveryProvidersById({ path: { id: draft.id } }))
        : apiData(postApiV1AdminSettingsDeliveryProvidersCreateTest({
          body: {
            type: draft.type,
            name: draft.name.trim() || undefined,
            credentials: JSON.stringify(draft.credentials),
            config: JSON.stringify(draft.config),
          } as ApiBody<typeof postApiV1AdminSettingsDeliveryProvidersCreateTest>,
        }));
    },
    onSuccess: async (result) => {
      if (result.success) toast.success(t("testOk"));
      // An app's own answer is merchant-facing; the built-ins' never leaves the API.
      else if (app) toast.error(t("appTestFailed", { app: app.appName }), { description: result.message });
      else toast.error(t("testFailed"));
      if (courier && builtIn) await refresh();
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
    fields: { name: "courier-name", baseUrl: "courier-base-url" },
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    // Fail closed: a courier can't be switched on until its keys are complete.
    invalid: !draft.name.trim() || (draft.isActive && blocked),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const courierLabel = builtIn === "pathao" ? "Pathao" : builtIn === "steadfast" ? "Steadfast" : app?.name ?? courier?.name ?? draft.type;
  const webhookKey = text(draft.credentials.webhookSecret);
  const typeOptions = [
    { value: "pathao", label: "Pathao" },
    { value: "steadfast", label: "Steadfast" },
    ...appCouriers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.appName })),
    // A saved courier whose app this screen can't list still names itself.
    ...(courier && !isBuiltIn(courier.type) && !appCouriers.some((provider) => provider.id === courier.type)
      ? [{ value: courier.type, label: courier.name }]
      : []),
  ];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="courier-name" label={t("courierName")}>
          <Input id="courier-name" value={draft.name} placeholder={courierLabel} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SettingsField>
        <SettingsField id="courier-type" label={t("courierType")}>
          <SearchableSelect
            id="courier-type"
            value={draft.type}
            disabled={Boolean(courier)}
            onValueChange={(type) => {
              setDraft({
                ...draft,
                type,
                credentials: isBuiltIn(type) ? { ...DEFAULTS[type].credentials } : {},
                config: isBuiltIn(type) ? { ...DEFAULTS[type].config } : {},
              });
            }}
            triggerClassName="w-full"
            options={typeOptions}
          />
        </SettingsField>
      </div>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("courierOn")}</span>
          {blocked ? (
            <span className="block text-muted-foreground">
              {builtIn ? t("courierOnBlocked") : app ? appCourierStatus(t, app) : t("appCourierInactive", { app: courierLabel })}
            </span>
          ) : null}
        </span>
        <Switch
          checked={draft.isActive}
          disabled={!draft.isActive && blocked}
          onCheckedChange={(isActive) => setDraft({ ...draft, isActive })}
        />
      </label>
      {builtIn ? (
        <BuiltInCourierFields
          type={builtIn}
          draft={draft}
          environment={environment}
          setEnvironment={setEnvironment}
          setCredential={setCredential}
          setConfig={setConfig}
          saved={Boolean(courier)}
          apiUrl={apiUrl}
          courierLabel={courierLabel}
          webhookKey={webhookKey}
        />
      ) : app ? (
        <AppCourierFields app={app} apiUrl={apiUrl} courierLabel={courierLabel} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          loading={test.isPending}
          disabled={builtIn ? !courier && blocked : !app?.canTestConnection || !canTestApps}
          onClick={() => test.mutate()}
        >
          {t("test")}
        </Button>
        {builtIn && !courier && blocked ? <p className="text-body text-muted-foreground">{t("testNeedsKeys")}</p> : null}
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

/** A courier app keeps its keys in its own settings: show where, whether it can book, and its update link. */
function AppCourierFields({ app, apiUrl, courierLabel }: { app: AppProvider; apiUrl: string; courierLabel: string }) {
  const t = useMessages(shippingMessages);
  const canOpenApp = useHasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  return (
    <>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <p className="text-body">{t("appCourierSetup", { app: app.appName })}</p>
          <p className="text-body text-muted-foreground">{appCourierStatus(t, app)}</p>
        </div>
        {canOpenApp ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/apps/$pluginId" params={{ pluginId: app.pluginId }}>{t("openAppSettings", { app: app.appName })}</Link>
          </Button>
        ) : null}
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

type CourierDraft = {
  credentials: Record<string, string | number>;
  config: Record<string, string | number>;
};

/** Pathao and Steadfast keep their account, keys and options on the courier itself. */
function BuiltInCourierFields({
  type,
  draft,
  environment,
  setEnvironment,
  setCredential,
  setConfig,
  saved,
  apiUrl,
  courierLabel,
  webhookKey,
}: {
  type: CourierType;
  draft: CourierDraft;
  environment: Environment;
  setEnvironment: (next: Environment) => void;
  setCredential: (key: string, value: string) => void;
  setConfig: (key: string, value: string | number) => void;
  saved: boolean;
  apiUrl: string;
  courierLabel: string;
  webhookKey: string;
}) {
  const t = useMessages(shippingMessages);
  const text = (value: string | number | undefined) => String(value ?? "");
  return (
    <>
      <SettingsField id="courier-environment" label={t("environment")} help={saved ? t("environmentChanged") : undefined}>
        <SearchableSelect
          id="courier-environment"
          aria-describedby="courier-environment-note"
          value={environment}
          onValueChange={(value) => setEnvironment(value as Environment)}
          triggerClassName="w-full"
          options={[{ value: "production", label: t("production") }, ...(type === "pathao" ? [{ value: "sandbox", label: t("sandbox") }] : []), { value: "custom", label: t("custom") }]}
        />
      </SettingsField>
      {environment === "custom" ? (
        <SettingsField id="courier-base-url" label={t("baseUrl")}>
          <Input id="courier-base-url" type="url" value={text(draft.credentials.baseUrl)} onChange={(event) => setCredential("baseUrl", event.target.value)} />
        </SettingsField>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {SECRET_FIELDS[type].map(({ key, label, secret }) => {
          const value = text(draft.credentials[key]);
          return (
            <SettingsField key={key} id={`courier-${key}`} label={t(label)} help={value === MASKED ? t("secretSaved") : undefined}>
              <Input
                id={`courier-${key}`}
                type={secret ? "password" : "text"}
                autoComplete="off"
                value={value}
                aria-describedby={`courier-${key}-note`}
                onFocus={() => value === MASKED && setCredential(key, "")}
                onChange={(event) => setCredential(key, event.target.value)}
              />
            </SettingsField>
          );
        })}
      </div>
      {type === "pathao" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField id="courier-store" label={t("storeId")}>
            <Input id="courier-store" inputMode="numeric" value={text(draft.config.storeId)} onChange={(event) => setConfig("storeId", event.target.value)} />
          </SettingsField>
          <SettingsField id="courier-weight" label={t("weight")}>
            <Input id="courier-weight" type="number" min="0.1" step="0.1" value={text(draft.config.defaultItemWeight)} onChange={(event) => setConfig("defaultItemWeight", Number(event.target.value))} />
          </SettingsField>
          <SettingsField id="courier-speed" label={t("deliveryType")}>
            <SearchableSelect
              id="courier-speed"
              value={text(draft.config.defaultDeliveryType || 48)}
              onValueChange={(value) => setConfig("defaultDeliveryType", Number(value))}
              triggerClassName="w-full"
              options={[{ value: "48", label: t("regular") }, { value: "12", label: t("express") }]}
            />
          </SettingsField>
          <SettingsField id="courier-item" label={t("itemType")}>
            <SearchableSelect
              id="courier-item"
              value={text(draft.config.defaultItemType || 2)}
              onValueChange={(value) => setConfig("defaultItemType", Number(value))}
              triggerClassName="w-full"
              options={[{ value: "2", label: t("parcel") }, { value: "1", label: t("document") }]}
            />
          </SettingsField>
        </div>
      ) : null}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-body font-medium">{t("updatesTitle")}</p>
        <p className="text-body text-muted-foreground">{t("updatesHelp", { courier: courierLabel })}</p>
        {apiUrl ? <CopyField id="courier-webhook-url" label={t("updatesUrl")} value={`${apiUrl}/api/v1/webhooks/${type}`} /> : null}
        {webhookKey && webhookKey !== MASKED ? (
          <CopyField id="courier-webhook-key" label={t("updatesKey")} value={webhookKey} />
        ) : webhookKey === MASKED ? (
          <p className="text-body text-muted-foreground">{t("keyHidden")}</p>
        ) : null}
        <Button type="button" variant="outline" onClick={() => setCredential("webhookSecret", newWebhookKey())}>
          {t("newKey")}
        </Button>
      </div>
    </>
  );
}

export function CouriersCard() {
  const t = useMessages(shippingMessages);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT);
  const { data, isError, refetch } = useQuery({ ...couriersQuery, enabled: canView });
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
                  <ProviderIcon type={courier.type} size="sm" />
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
