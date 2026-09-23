import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsDeliveryProvidersById,
  deleteApiV1AdminSettingsShippingMethodsById,
  getApiV1AdminSettingsDeliveryLocations,
  getApiV1AdminSettingsShippingMethods,
  postApiV1AdminSettingsDeliveryProvidersById,
  postApiV1AdminSettingsShippingMethods,
  putApiV1AdminSettingsDeliveryProviders,
  putApiV1AdminSettingsShippingMethodsById,
} from "@scalius/api-client/sdk";
import { getDeliveryProviderActivationBlockers } from "@scalius/core/modules/delivery/provider-readiness";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiBody, type ApiResult } from "~/lib/api";
import { deliveryProvidersQueryOptions, type DeliveryProviderRecord } from "~/lib/api-query-options/delivery";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { ProviderIcon, resolveProviderReadiness } from "../delivery-providers/ProviderIcon";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsDialog, SettingsField, SettingsRow, SettingsCardLoading } from "./SettingsPage";
import { currencyQuery, platformQuery } from "./StoreSettings";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED = "••••••••••••";

type ShippingMethod = ApiResult<typeof getApiV1AdminSettingsShippingMethods>["shippingMethods"][number];

const RATES_PARAMS = { page: 1, limit: 100, sort: "sortOrder", order: "asc" } as const;
export const shippingRatesQuery = {
  queryKey: queryKeys.settings.shippingMethods(RATES_PARAMS),
  queryFn: () => apiData(getApiV1AdminSettingsShippingMethods({ query: RATES_PARAMS })),
};
export const areaCountsQuery = {
  queryKey: [...queryKeys.settings.deliveryLocations(), "counts"],
  queryFn: async () => {
    const [cities, zones, areas] = await Promise.all(
      (["city", "zone", "area"] as const).map((type) =>
        apiData(getApiV1AdminSettingsDeliveryLocations({ query: { type, page: 1, limit: 1 } })),
      ),
    );
    return { cities: cities!.pagination.total, zones: zones!.pagination.total, areas: areas!.pagination.total };
  },
};
export const couriersQuery = deliveryProvidersQueryOptions();

function refreshCheckout(queryClient: ReturnType<typeof useQueryClient>, key: readonly unknown[]) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: key }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
  ]);
}

// ── Delivery charges (shipping methods) ────────────────────────────────

function RateForm({ rate }: { rate: ShippingMethod | null }) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const [saved] = useState(() => ({
    name: rate?.name ?? "",
    fee: rate ? String(rate.fee) : "",
    description: rate?.description ?? "",
    isActive: rate?.isActive ?? true,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fee = Number(draft.fee);
  const feeValid = draft.fee.trim() !== "" && Number.isFinite(fee) && fee >= 0;
  const refresh = () => refreshCheckout(queryClient, queryKeys.settings.shippingMethods());
  const save = useMutation({
    mutationFn: () => {
      const body = { name: draft.name.trim(), fee, description: draft.description.trim(), isActive: draft.isActive };
      return rate
        ? apiData(putApiV1AdminSettingsShippingMethodsById({ path: { id: rate.id }, body }))
        : apiData(postApiV1AdminSettingsShippingMethods({ body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminSettingsShippingMethodsById({ path: { id: rate!.id } })),
    onSuccess: async () => {
      toast.success(t("rateDeleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  useSaveBar({
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || !feeValid,
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const symbol = useQuery(currencyQuery).data?.currencySymbol ?? "";
  return (
    <>
      <SettingsField id="rate-name" label={t("rateName")}>
        <Input id="rate-name" value={draft.name} placeholder={t("rateNamePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      <SettingsField id="rate-fee" label={`${t("fee")} (${symbol})`} error={draft.fee && !feeValid ? t("feeInvalid") : null}>
        <Input
          id="rate-fee"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          className="max-w-40"
          value={draft.fee}
          aria-invalid={Boolean(draft.fee) && !feeValid}
          aria-describedby="rate-fee-note"
          onChange={(event) => setDraft({ ...draft, fee: event.target.value })}
        />
      </SettingsField>
      <SettingsField id="rate-description" label={t("rateDescription")}>
        <Textarea id="rate-description" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      </SettingsField>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body font-medium">
        {t("showAtCheckout")}
        <Switch checked={draft.isActive} onCheckedChange={(isActive) => setDraft({ ...draft, isActive })} />
      </label>
      {rate ? (
        <>
          <Button type="button" variant="ghost" className="self-start" onClick={() => setConfirmDelete(true)}>
            {t("deleteRate")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={t("deleteRate")}
            description={t("deleteRateConfirm", { name: rate.name })}
            confirmLabel={common("delete")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </>
      ) : null}
    </>
  );
}

const DHAKA_ZONES = [
  { name: "insideDhaka", note: "insideDhakaNote", fee: "70" },
  { name: "nearDhaka", note: "nearDhakaNote", fee: "90" },
  { name: "outsideDhaka", note: "outsideDhakaNote", fee: "120" },
] as const;

/** Bangladesh's usual three zones as a starting point; nothing is added until Save. */
function DhakaZonesForm() {
  const t = useMessages(shippingMessages);
  const queryClient = useQueryClient();
  const symbol = useQuery(currencyQuery).data?.currencySymbol ?? "";
  const [saved] = useState(() => DHAKA_ZONES.map((zone) => ({ name: t(zone.name), fee: zone.fee, description: t(zone.note) })));
  const [draft, setDraft] = useState(saved);
  const valid = draft.every((zone) => zone.name.trim() && zone.fee.trim() !== "" && Number(zone.fee) >= 0);
  const save = useMutation({
    mutationFn: async () => {
      for (const [sortOrder, zone] of draft.entries()) {
        await apiData(postApiV1AdminSettingsShippingMethods({
          body: { name: zone.name.trim(), fee: Number(zone.fee), description: zone.description, isActive: true, sortOrder },
        }));
      }
    },
    onSettled: () => refreshCheckout(queryClient, queryKeys.settings.shippingMethods()),
  });
  // Always savable: opening the dialog is the choice to add the zones.
  useSaveBar({ dirty: true, saving: save.isPending, invalid: !valid, save: () => save.mutateAsync(), discard: () => setDraft(saved) });
  const update = (index: number, field: "name" | "fee", value: string) =>
    setDraft(draft.map((zone, i) => (i === index ? { ...zone, [field]: value } : zone)));
  return (
    <>
      <p className="text-body text-muted-foreground">{t("dhakaHelp")}</p>
      {draft.map((zone, index) => (
        <div key={DHAKA_ZONES[index]!.name} className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <SettingsField id={`dhaka-${index}-name`} label={t("rateName")} help={zone.description}>
              <Input id={`dhaka-${index}-name`} value={zone.name} aria-describedby={`dhaka-${index}-name-note`} onChange={(event) => update(index, "name", event.target.value)} />
            </SettingsField>
          </div>
          <SettingsField id={`dhaka-${index}-fee`} label={`${t("fee")} (${symbol})`}>
            <Input
              id={`dhaka-${index}-fee`}
              type="number"
              inputMode="decimal"
              min="0"
              value={zone.fee}
              aria-invalid={zone.fee.trim() === "" || Number(zone.fee) < 0}
              onChange={(event) => update(index, "fee", event.target.value)}
            />
          </SettingsField>
        </div>
      ))}
    </>
  );
}

export function DeliveryChargesCard() {
  const t = useMessages(shippingMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const { data, isError, refetch } = useQuery({ ...shippingRatesQuery, enabled: canView });
  const currency = useQuery(currencyQuery).data;
  const symbol = currency?.currencySymbol ?? "";
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadRates")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const offerDhaka = canEdit && data.shippingMethods.length === 0 && currency?.currencyCode === "BDT";
  return (
    <SettingsCard
      id="deliveryCharges"
      title={t("ratesTitle")}
      description={data.shippingMethods.length ? t("ratesDescription") : t("noRates")}
      action={
        <SettingsDialog title={t("addRate")} trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addRate")}</Button>}>
          <RateForm rate={null} />
        </SettingsDialog>
      }
      rows={offerDhaka ? (
        <SettingsDialog title={t("dhakaAdd")} trigger={<SettingsRow label={t("dhakaTitle")} value={t("dhakaDescription")} />}>
          <DhakaZonesForm />
        </SettingsDialog>
      ) : data.shippingMethods.length === 0 ? undefined : data.shippingMethods.map((rate) => (
        <SettingsDialog key={rate.id} title={t("editRate", { name: rate.name })} trigger={
          <SettingsRow
            disabled={!canEdit}
            label={rate.name}
            value={`${symbol}${formatNumber(rate.fee)}${rate.isActive ? "" : ` · ${t("off")}`}`}
          />
        }>
          <RateForm rate={rate} />
        </SettingsDialog>
      ))}
    />
  );
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
    credentials: { baseUrl: ENDPOINTS.pathao.production, clientId: "", clientSecret: "", username: "", password: "", webhookSecret: "" },
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
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminSettingsDeliveryProvidersById({ path: { id: draft.id } })),
    onSuccess: async (result) => {
      if (result.success) toast.success(t("testOk"));
      else toast.error(t("testFailed"));
      await refresh();
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
          <Select
            value={draft.type}
            disabled={Boolean(courier)}
            onValueChange={(value) => {
              const type = value as CourierType;
              setDraft({ ...draft, type, credentials: { ...DEFAULTS[type].credentials }, config: { ...DEFAULTS[type].config } });
            }}
          >
            <SelectTrigger id="courier-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pathao">Pathao</SelectItem>
              <SelectItem value="steadfast">Steadfast</SelectItem>
            </SelectContent>
          </Select>
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
        <Select value={environment} onValueChange={(value) => setEnvironment(value as Environment)}>
          <SelectTrigger id="courier-environment" aria-describedby="courier-environment-note"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="production">{t("production")}</SelectItem>
            {draft.type === "pathao" ? <SelectItem value="sandbox">{t("sandbox")}</SelectItem> : null}
            <SelectItem value="custom">{t("custom")}</SelectItem>
          </SelectContent>
        </Select>
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
            <Select value={text(draft.config.defaultDeliveryType || 48)} onValueChange={(value) => setConfig("defaultDeliveryType", Number(value))}>
              <SelectTrigger id="courier-speed"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="48">{t("regular")}</SelectItem>
                <SelectItem value="12">{t("express")}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsField>
          <SettingsField id="courier-item" label={t("itemType")}>
            <Select value={text(draft.config.defaultItemType || 2)} onValueChange={(value) => setConfig("defaultItemType", Number(value))}>
              <SelectTrigger id="courier-item"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="2">{t("parcel")}</SelectItem>
                <SelectItem value="1">{t("document")}</SelectItem>
              </SelectContent>
            </Select>
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
      {courier ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
            {t("test")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
            {t("deleteCourier")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={t("deleteCourier")}
            description={t("deleteCourierConfirm", { name: courier.name })}
            confirmLabel={common("delete")}
            cancelLabel={common("cancel")}
            isLoading={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
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
