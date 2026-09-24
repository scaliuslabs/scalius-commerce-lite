import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsDeliveryProvidersCreateTest,
  putApiV1AdminSettingsDeliveryProviders,
} from "@scalius/api-client/sdk";
import { getDeliveryProviderActivationBlockers } from "@scalius/core/modules/delivery/browser";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiBody } from "~/lib/api";
import type { DeliveryProviderRecord } from "~/lib/api-query-options/delivery";
import { areaCountsQuery, couriersQuery, platformQuery } from "~/lib/api-query-options/settings-screens";
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

type CourierType = "pathao" | "steadfast";
type Environment = "production" | "sandbox" | "custom";
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
  const [saved] = useState(() => {
    const type = (courier?.type as CourierType | undefined) ?? "pathao";
    return {
      id: courier?.id ?? crypto.randomUUID(),
      name: courier?.name ?? "",
      type,
      isActive: courier?.isActive ?? false,
      credentials: courier ? parse(courier.credentials) : { ...DEFAULTS[type].credentials },
      config: courier ? parse(courier.config) : { ...DEFAULTS[type].config },
    };
  });
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const blockers = getDeliveryProviderActivationBlockers({ type: draft.type, credentials: draft.credentials, config: draft.config });
  const text = (value: string | number | undefined) => String(value ?? "");
  const setCredential = (key: string, value: string) =>
    setDraft((current) => ({ ...current, credentials: { ...current.credentials, [key]: value } }));
  const setConfig = (key: string, value: string | number) =>
    setDraft((current) => ({ ...current, config: { ...current.config, [key]: value } }));
  const environment = environmentOf(draft.type, text(draft.credentials.baseUrl));
  const setEnvironment = (next: Environment) =>
    setDraft((current) => ({
      ...current,
      // A different account never keeps the other account's keys.
      credentials: {
        ...DEFAULTS[current.type].credentials,
        webhookSecret: text(current.credentials.webhookSecret),
        baseUrl: next === "custom" ? "" : next === "sandbox" ? ENDPOINTS.pathao.sandbox : ENDPOINTS[current.type].production,
      },
      config: current.type === "pathao" ? { ...current.config, storeId: "" } : current.config,
    }));
  const refresh = () => refreshCheckout(queryClient, queryKeys.settings.deliveryProviders());
  const save = useMutation({
    mutationFn: () =>
      apiData(putApiV1AdminSettingsDeliveryProviders({
        body: {
          id: draft.id,
          name: draft.name.trim(),
          type: draft.type,
          isActive: draft.isActive,
          credentials: JSON.stringify(draft.credentials),
          config: JSON.stringify(draft.config),
        } as ApiBody<typeof putApiV1AdminSettingsDeliveryProviders>,
      })),
    onSuccess: refresh,
  });
  // A saved courier tests its saved keys; a new one tests the keys typed so far.
  const test = useMutation({
    mutationFn: () => courier
      ? apiData(postApiV1AdminSettingsDeliveryProvidersById({ path: { id: draft.id } }))
      : apiData(postApiV1AdminSettingsDeliveryProvidersCreateTest({
          body: {
            type: draft.type,
            name: draft.name.trim() || undefined,
            credentials: JSON.stringify(draft.credentials),
            config: JSON.stringify(draft.config),
          } as ApiBody<typeof postApiV1AdminSettingsDeliveryProvidersCreateTest>,
        })),
    onSuccess: async (result) => {
      if (result.success) toast.success(t("testOk"));
      else toast.error(t("testFailed"));
      if (courier) await refresh();
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
    invalid: !draft.name.trim() || (draft.isActive && blockers.length > 0),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const courierLabel = draft.type === "pathao" ? "Pathao" : "Steadfast";
  const webhookKey = text(draft.credentials.webhookSecret);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="courier-name" label={t("courierName")}>
          <Input id="courier-name" value={draft.name} placeholder={courierLabel} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SettingsField>
        <SettingsField id="courier-type" label={t("courierType")}>
          <NativeSelect
            id="courier-type"
            value={draft.type}
            disabled={Boolean(courier)}
            onValueChange={(value) => {
              const type = value as CourierType;
              setDraft({ ...draft, type, credentials: { ...DEFAULTS[type].credentials }, config: { ...DEFAULTS[type].config } });
            }}
          >
            <option value="pathao">Pathao</option>
            <option value="steadfast">Steadfast</option>
          </NativeSelect>
        </SettingsField>
      </div>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("courierOn")}</span>
          {blockers.length ? <span className="block text-muted-foreground">{t("courierOnBlocked")}</span> : null}
        </span>
        <Switch
          checked={draft.isActive}
          disabled={!draft.isActive && blockers.length > 0}
          onCheckedChange={(isActive) => setDraft({ ...draft, isActive })}
        />
      </label>
      <SettingsField id="courier-environment" label={t("environment")} help={courier ? t("environmentChanged") : undefined}>
        <NativeSelect
          id="courier-environment"
          aria-describedby="courier-environment-note"
          value={environment}
          onValueChange={(value) => setEnvironment(value as Environment)}
        >
          <option value="production">{t("production")}</option>
          {draft.type === "pathao" ? <option value="sandbox">{t("sandbox")}</option> : null}
          <option value="custom">{t("custom")}</option>
        </NativeSelect>
      </SettingsField>
      {environment === "custom" ? (
        <SettingsField id="courier-base-url" label={t("baseUrl")}>
          <Input id="courier-base-url" type="url" value={text(draft.credentials.baseUrl)} onChange={(event) => setCredential("baseUrl", event.target.value)} />
        </SettingsField>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {SECRET_FIELDS[draft.type].map(({ key, label, secret }) => {
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
      {draft.type === "pathao" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField id="courier-store" label={t("storeId")}>
            <Input id="courier-store" inputMode="numeric" value={text(draft.config.storeId)} onChange={(event) => setConfig("storeId", event.target.value)} />
          </SettingsField>
          <SettingsField id="courier-weight" label={t("weight")}>
            <Input id="courier-weight" type="number" min="0.1" step="0.1" value={text(draft.config.defaultItemWeight)} onChange={(event) => setConfig("defaultItemWeight", Number(event.target.value))} />
          </SettingsField>
          <SettingsField id="courier-speed" label={t("deliveryType")}>
            <NativeSelect id="courier-speed" value={text(draft.config.defaultDeliveryType || 48)} onValueChange={(value) => setConfig("defaultDeliveryType", Number(value))}>
              <option value="48">{t("regular")}</option>
              <option value="12">{t("express")}</option>
            </NativeSelect>
          </SettingsField>
          <SettingsField id="courier-item" label={t("itemType")}>
            <NativeSelect id="courier-item" value={text(draft.config.defaultItemType || 2)} onValueChange={(value) => setConfig("defaultItemType", Number(value))}>
              <option value="2">{t("parcel")}</option>
              <option value="1">{t("document")}</option>
            </NativeSelect>
          </SettingsField>
        </div>
      ) : null}
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-body font-medium">{t("updatesTitle")}</p>
        <p className="text-body text-muted-foreground">{t("updatesHelp", { courier: courierLabel })}</p>
        {apiUrl ? <CopyField id="courier-webhook-url" label={t("updatesUrl")} value={`${apiUrl}/api/v1/webhooks/${draft.type}`} /> : null}
        {webhookKey && webhookKey !== MASKED ? (
          <CopyField id="courier-webhook-key" label={t("updatesKey")} value={webhookKey} />
        ) : webhookKey === MASKED ? (
          <p className="text-body text-muted-foreground">{t("keyHidden")}</p>
        ) : null}
        <Button type="button" variant="outline" onClick={() => setCredential("webhookSecret", newWebhookKey())}>
          {t("newKey")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          loading={test.isPending}
          disabled={!courier && blockers.length > 0}
          onClick={() => test.mutate()}
        >
          {t("test")}
        </Button>
        {!courier && blockers.length > 0 ? <p className="text-body text-muted-foreground">{t("testNeedsKeys")}</p> : null}
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
