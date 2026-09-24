import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Banknote } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminSettingsSslcommerz,
  deleteApiV1AdminSettingsStripe,
  getApiV1AdminSettingsCheckoutFlow,
  getApiV1AdminSettingsPaymentMethods,
  getApiV1AdminSettingsSslcommerz,
  getApiV1AdminSettingsStripe,
  postApiV1AdminSettingsPaymentMethods,
  postApiV1AdminSettingsSslcommerz,
  postApiV1AdminSettingsStripe,
  putApiV1AdminSettingsCheckoutFlow,
} from "@scalius/api-client/sdk";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { AdminApiResponseError, readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiResult } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, getLocale, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { paymentsMessages } from "~/i18n/settings-payments";
import { saveBarMessages } from "~/i18n/save-bar";
import {
  CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS,
  getCheckoutFlowPreviewIssues,
} from "./checkout-flow-policy";
import {
  getEligibleDefaultPaymentMethods,
  getPaymentMethodFlowEligibility,
  getPaymentMethodFlowExclusionReason,
  getPaymentMethodOutcome,
  type GatewayStatus,
  type MethodKey,
} from "./payment-method-outcome";
import { OfficialProviderMark } from "./provider-marks";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useWholeCashAmounts } from "../shared/MoneyInput";
import { SettingsCard, SettingsDialog, SettingsField, SettingsCardLoading, useCloseSettingsDialog } from "./SettingsPage";
import { currencyQuery, platformQuery } from "./StoreSettings";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED = "••••••••••••";
const METHODS: MethodKey[] = ["cod", "sslcommerz", "stripe"];

type CheckoutFlow = Omit<ApiResult<typeof getApiV1AdminSettingsCheckoutFlow>, "revision">;
type PaymentMethods = Omit<ApiResult<typeof getApiV1AdminSettingsPaymentMethods>, "enabledMethods" | "defaultMethod" | "gatewayStatus"> & {
  enabledMethods: MethodKey[];
  defaultMethod: MethodKey;
  gatewayStatus: Partial<Record<MethodKey, GatewayStatus>>;
};

export const checkoutFlowQuery = {
  queryKey: queryKeys.settings.checkoutFlow(),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutFlow()),
};
export const paymentMethodsQuery = {
  queryKey: queryKeys.settings.paymentMethods(),
  queryFn: async () => (await apiData(getApiV1AdminSettingsPaymentMethods())) as unknown as PaymentMethods,
};
/** A gateway document as read: keys, flags and its `revision` (kept apart from the form values). */
type GatewayValues = Record<string, string | boolean | number>;
export const gatewayQuery = (gateway: "stripe" | "sslcommerz") => ({
  queryKey: queryKeys.settings.paymentGateway(gateway),
  queryFn: async (): Promise<GatewayValues> =>
    gateway === "stripe"
      ? await apiData(getApiV1AdminSettingsStripe())
      : await apiData(getApiV1AdminSettingsSslcommerz()),
});

type GatewayKey = "secretKey" | "publishableKey" | "webhookSecret" | "storeId" | "storePassword";
/** Every key a gateway needs before it can be turned on, and the field showing it. */
const GATEWAY_KEYS: Record<"stripe" | "sslcommerz", Partial<Record<GatewayKey, string>>> = {
  stripe: { secretKey: "stripe-secret", publishableKey: "stripe-publishable", webhookSecret: "stripe-webhook" },
  sslcommerz: { storeId: "ssl-store-id", storePassword: "ssl-password" },
};

/** "publishable key and webhook secret", in the dashboard language. */
function useKeyList() {
  const t = useMessages(paymentsMessages);
  return (keys: readonly string[]) =>
    new Intl.ListFormat(getLocale() === "bn" ? "bn" : "en", { type: "conjunction" })
      .format(keys.map((key) => t(`key_${key as GatewayKey}`)));
}

function useCanEditPayments() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

/** The checkout flow (guest checkout, gateways, advance payment). */
export function useCheckoutFlowForm(isValid: (draft: CheckoutFlow) => boolean, label?: string) {
  const common = useMessages(settingsMessages);
  return useSettingsForm<CheckoutFlow, CheckoutFlow>({
    label,
    queryKey: checkoutFlowQuery.queryKey,
    fetchFn: checkoutFlowQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(putApiV1AdminSettingsCheckoutFlow({
        body: {
          guestCheckoutEnabled: draft.guestCheckoutEnabled,
          checkoutMode: draft.checkoutMode,
          partialPaymentEnabled: draft.partialPaymentEnabled,
          partialPaymentAmount: draft.partialPaymentAmount,
          expectedRevision,
        },
      })),
    resolveSavedValues: (saved) => saved,
    invalidateQueryKeys: [queryKeys.settings.checkoutReadiness(), paymentMethodsQuery.queryKey],
    defaultValues: {} as CheckoutFlow,
    errorMessage: common("saveFailed"),
    canEdit: useCanEditPayments(),
    isValid,
  });
}

function usableMethods(methods: PaymentMethods | undefined) {
  const usable = (method: MethodKey) => {
    const status = methods?.gatewayStatus[method];
    return methods?.enabledMethods.includes(method) === true && (status?.usable ?? (status?.enabled === true && status?.configured === true));
  };
  return {
    codEnabled: usable("cod"),
    online: METHODS.filter((method) => method !== "cod" && usable(method)),
  };
}

// ── Payment methods ─────────────────────────────────────────────────────

function MethodMark({ method }: { method: MethodKey }) {
  if (method === "cod") {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
        <Banknote className="size-5" />
      </span>
    );
  }
  return <OfficialProviderMark provider={method} />;
}

/**
 * A write-only key. A saved one never comes back: the field shows the mask as
 * its placeholder and says it's saved; typing replaces it, and clearing the
 * field keeps the saved key.
 */
function PasswordField({
  id,
  label,
  value,
  saved,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  saved: boolean;
  error?: string | null;
  onChange: (value: string) => void;
}) {
  const t = useMessages(paymentsMessages);
  const keepsSaved = saved && value === MASKED;
  return (
    <SettingsField id={id} label={label} help={keepsSaved ? t("secretSaved") : undefined} error={error}>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        value={keepsSaved ? "" : value}
        placeholder={keepsSaved ? MASKED : undefined}
        aria-describedby={`${id}-note`}
        onChange={(event) => onChange(event.target.value || (saved ? MASKED : ""))}
      />
    </SettingsField>
  );
}

/**
 * A gateway's keys. They can be saved a few at a time; the gateway turns on
 * once every key is there. `turnOn` (the merchant flipped its checkout
 * switch) requires every key and marks the missing ones.
 */
function GatewayFields({
  gateway,
  turnOn = false,
  onTurnedOn,
}: {
  gateway: "stripe" | "sslcommerz";
  turnOn?: boolean;
  onTurnedOn?: () => void;
}) {
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  const keyList = useKeyList();
  const query = gatewayQuery(gateway);
  const saved = useQuery(query).data;
  const platform = useQuery(platformQuery);
  // An empty secret keeps the saved one; an empty publishable key clears it.
  const missingKeys = (draft: GatewayValues) =>
    (Object.keys(GATEWAY_KEYS[gateway]) as GatewayKey[]).filter((key) =>
      !String(draft[key] ?? "").trim() && (key === "publishableKey" || !String(saved?.[key] ?? "").trim()));
  const { values, setValue } = useSettingsForm<GatewayValues>({
    queryKey: query.queryKey,
    fetchFn: query.queryFn,
    saveFn: async (draft, expectedRevision) => {
      const body = { ...draft, enabled: turnOn || missingKeys(draft).length === 0, expectedRevision };
      const result = gateway === "stripe"
        ? await apiData(postApiV1AdminSettingsStripe({ body }))
        : await apiData(postApiV1AdminSettingsSslcommerz({ body }));
      if (turnOn) onTurnedOn?.();
      return result;
    },
    invalidateQueryKeys: [paymentMethodsQuery.queryKey, checkoutFlowQuery.queryKey, queryKeys.settings.checkoutReadiness()],
    defaultValues: {},
    errorMessage: common("saveFailed"),
    canEdit: useCanEditPayments(),
    isValid: (draft) => !turnOn || missingKeys(draft).length === 0,
    fields: GATEWAY_KEYS[gateway],
  });
  const text = (key: string) => String(values[key] ?? "");
  if (values.enabled === undefined || !saved) return null;
  const missing = turnOn ? missingKeys(values) : [];
  const turnOnError = (key: GatewayKey) =>
    missing.includes(key) ? t("turnOnNeeds", { fields: keyList(missing), method: t(gateway) }) : null;
  const secret = (id: string, key: GatewayKey, label: string) => (
    <PasswordField
      id={id}
      label={label}
      value={text(key)}
      saved={saved[key] === MASKED}
      error={turnOnError(key)}
      onChange={(value) => setValue(key, value)}
    />
  );
  const removable = Object.keys(GATEWAY_KEYS[gateway]).some((key) => String(saved[key] ?? "").trim());
  const remove = removable ? <RemoveKeys gateway={gateway} revision={Number(saved.revision)} /> : null;

  if (gateway === "sslcommerz") {
    return (
      <>
        <label className="flex min-h-11 items-center justify-between gap-4 text-body">
          <span>
            <span className="block font-medium">{t("testModeLabel")}</span>
            <span className="block text-muted-foreground">{values.sandbox ? t("testModeHelp") : t("liveWarning")}</span>
          </span>
          <Switch checked={Boolean(values.sandbox)} onCheckedChange={(sandbox) => setValue("sandbox", sandbox)} />
        </label>
        <SettingsField id="ssl-store-id" label={t("storeId")} error={turnOnError("storeId")}>
          <Input id="ssl-store-id" autoComplete="off" value={text("storeId")} onChange={(event) => setValue("storeId", event.target.value)} />
        </SettingsField>
        {secret("ssl-password", "storePassword", t("storePassword"))}
        {remove}
      </>
    );
  }

  const environment = getStripeCredentialEnvironment({
    secretKey: text("secretKey"),
    publishableKey: text("publishableKey"),
  });
  return (
    <>
      {secret("stripe-secret", "secretKey", t("secretKey"))}
      <SettingsField
        id="stripe-publishable"
        label={t("publishableKey")}
        error={turnOnError("publishableKey")}
        help={environment === "live" ? t("liveWarning") : environment === "test" ? t("testMode") : environment === "mixed" ? t("keyMismatch") : undefined}
      >
        <Input
          id="stripe-publishable"
          autoComplete="off"
          value={text("publishableKey")}
          placeholder="pk_live_…"
          aria-describedby="stripe-publishable-note"
          onChange={(event) => setValue("publishableKey", event.target.value)}
        />
      </SettingsField>
      {secret("stripe-webhook", "webhookSecret", t("webhookSecret"))}
      {platform.data?.apiUrl ? (
        <p className="text-body text-muted-foreground">{t("webhookHelp", { url: `${platform.data.apiUrl}/api/v1/webhooks/stripe` })}</p>
      ) : null}
      {remove}
    </>
  );
}

/**
 * Shopify's Disconnect: deletes every saved key of the gateway and turns it
 * off at checkout. The server refuses it when checkout would be left without
 * a way to pay, as it refuses turning the gateway off.
 */
function RemoveKeys({ gateway, revision }: { gateway: "stripe" | "sslcommerz"; revision: number }) {
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  const bar = useMessages(saveBarMessages);
  const queryClient = useQueryClient();
  const closeDialog = useCloseSettingsDialog();
  const [confirming, setConfirming] = useState(false);
  const method = t(gateway);
  const refresh = () => Promise.all(
    [gatewayQuery(gateway).queryKey, paymentMethodsQuery.queryKey, checkoutFlowQuery.queryKey, queryKeys.settings.checkoutReadiness()]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
  const remove = useMutation({
    mutationFn: () => apiData(gateway === "stripe"
      ? deleteApiV1AdminSettingsStripe({ body: { expectedRevision: revision } })
      : deleteApiV1AdminSettingsSslcommerz({ body: { expectedRevision: revision } })),
    onSuccess: async () => {
      toast.success(t("keysRemoved"));
      closeDialog?.();
      await refresh();
    },
    // A refusal or a newer save: show why, with the latest keys loaded.
    onError: () => void refresh(),
  });
  const failure = !remove.error
    ? null
    : readSettingsRevisionConflict(remove.error)
      ? bar("conflict")
      : remove.error instanceof AdminApiResponseError && remove.error.status === 400
        ? t("removeBlocked", { method })
        : getServerFnError(remove.error);
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <Button type="button" variant="ghost" className="-ml-3" onClick={() => setConfirming(true)}>
        {t("removeKeys")}
      </Button>
      {failure ? <p role="alert" className="text-body text-destructive">{failure}</p> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("removeKeysTitle", { method })}
        description={t("removeKeysBody", { method })}
        confirmLabel={t("removeKeys")}
        cancelLabel={common("cancel")}
        isLoading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

export function PaymentMethodsCard() {
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  const keyList = useKeyList();
  const canEdit = useCanEditPayments();
  // Flipping on a gateway that still needs keys opens its setup to finish it.
  const [turningOn, setTurningOn] = useState<MethodKey | null>(null);
  const pendingTurnOn = useRef<MethodKey | null>(null);
  const setupButtons = useRef(new Map<MethodKey, HTMLButtonElement>());
  const flow = useQuery(checkoutFlowQuery);
  const currency = useQuery(currencyQuery);
  const flowAllowed = (method: MethodKey) =>
    flow.data ? getPaymentMethodFlowEligibility(method, flow.data) : undefined;
  const eligibilityIssue = (method: MethodKey) =>
    method === "sslcommerz" && currency.data?.currencyCode !== "BDT" ? "sslNeedsBdt" : null;
  const defaults = (draft: PaymentMethods) =>
    getEligibleDefaultPaymentMethods({
      methods: METHODS,
      statuses: draft.gatewayStatus,
      selectedMethods: new Set(draft.enabledMethods),
      flowAllowed,
      eligibilityIssue,
    });
  const { values, setValues, isLoadError, refetch } = useSettingsForm<PaymentMethods>({
    label: t("methodsTitle"),
    queryKey: paymentMethodsQuery.queryKey,
    fetchFn: paymentMethodsQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsPaymentMethods({
        body: { enabledMethods: draft.enabledMethods, defaultMethod: draft.defaultMethod, expectedRevision },
      })),
    invalidateQueryKeys: [checkoutFlowQuery.queryKey, queryKeys.settings.checkoutReadiness()],
    defaultValues: {} as PaymentMethods,
    errorMessage: common("saveFailed"),
    canEdit,
    // Fail closed: without the saved flow and currency, visibility is unknown.
    isValid: (draft) => Boolean(flow.data && currency.data) && defaults(draft).includes(draft.defaultMethod),
  });
  if (isLoadError || flow.isError || currency.isError) {
    return <SettingsLoadFailure title={t("loadMethods")} onRetry={() => Promise.all([refetch(), flow.refetch(), currency.refetch()])} />;
  }
  if (!values.enabledMethods) return <SettingsCardLoading />;

  const eligibleDefaults = defaults(values);
  const ordered = [
    ...values.enabledMethods,
    ...METHODS.filter((method) => !values.enabledMethods.includes(method)),
  ];
  const toggle = (method: MethodKey, on: boolean) =>
    setValues((draft) => {
      const enabledMethods = on
        ? [...draft.enabledMethods, method]
        : draft.enabledMethods.filter((item) => item !== method);
      const next = { ...draft, enabledMethods };
      const options = defaults(next);
      return { ...next, defaultMethod: options.includes(draft.defaultMethod) ? draft.defaultMethod : options[0] ?? draft.defaultMethod };
    });
  const move = (method: MethodKey, direction: -1 | 1) =>
    setValues((draft) => {
      const order = [...draft.enabledMethods];
      const index = order.indexOf(method);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return draft;
      [order[index], order[target]] = [order[target]!, order[index]!];
      return { ...draft, enabledMethods: order };
    });

  const rows = ordered.map((method) => {
    const selected = values.enabledMethods.includes(method);
    const outcome = getPaymentMethodOutcome({
      method,
      status: values.gatewayStatus[method],
      checkoutSelected: selected,
      flowAllowed: flowAllowed(method),
      eligibilityIssue: eligibilityIssue(method),
    });
    const environment = values.gatewayStatus[method]?.environment;
    const exclusion = flow.data && outcome.state === "hidden_by_flow" ? getPaymentMethodFlowExclusionReason(method, flow.data) : null;
    const missingKeys = values.gatewayStatus[method]?.missingFields ?? [];
    const needsKeys = outcome.state === "needs_setup" && missingKeys.length > 0;
    const detail = eligibilityIssue(method)
      ? t("sslNeedsBdt")
      : exclusion
        ? t(exclusion)
        : [
            needsKeys ? t("needsKeys", { fields: keyList(missingKeys) }) : t(outcome.state),
            method !== "cod" && environment === "test" ? t("testMode") : null,
            method !== "cod" && environment === "mixed" ? t("keyMismatch") : null,
          ].filter(Boolean).join(" · ");
    const position = values.enabledMethods.indexOf(method);
    const reorderable = selected && values.enabledMethods.length > 1;
    return (
      <li key={method} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <MethodMark method={method} />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">{t(method)}</p>
          <p className="text-body text-muted-foreground">{detail}</p>
        </div>
        {method !== "cod" || reorderable ? (
          // Secondary actions wrap under the name on phones.
          <div className="order-last flex w-full items-center gap-1 sm:order-none sm:w-auto">
            {reorderable ? (
              <>
                <Button type="button" variant="ghost" size="icon" disabled={!canEdit || position === 0} aria-label={t("moveUp", { method: t(method) })} onClick={() => move(method, -1)}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon" disabled={!canEdit || position === values.enabledMethods.length - 1} aria-label={t("moveDown", { method: t(method) })} onClick={() => move(method, 1)}>
                  <ArrowDown aria-hidden="true" />
                </Button>
              </>
            ) : null}
            {method !== "cod" ? (
              <SettingsDialog
                title={t("credentialsTitle", { method: t(method) })}
                description={turningOn === method && needsKeys ? t("turnOnNeeds", { fields: keyList(missingKeys), method: t(method) }) : undefined}
                trigger={
                  <Button
                    ref={(button) => {
                      if (button) setupButtons.current.set(method, button);
                      else setupButtons.current.delete(method);
                    }}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canEdit}
                    onClick={() => {
                      setTurningOn(pendingTurnOn.current);
                      pendingTurnOn.current = null;
                    }}
                  >
                    {outcome.state === "needs_setup" || outcome.state === "provider_off" ? t("set_up") : t("manage")}
                  </Button>
                }
              >
                <GatewayFields
                  gateway={method}
                  turnOn={turningOn === method}
                  // Keys complete: show it at checkout, saved with the page like any switch.
                  onTurnedOn={() => toggle(method, true)}
                />
              </SettingsDialog>
            ) : null}
          </div>
        ) : null}
        {/* A 44px hit area around the small switch (touch target). */}
        <label className="-mx-1 -my-3 flex size-11 items-center justify-center">
          <Switch
            checked={selected}
            disabled={!canEdit || (!selected && !outcome.canSelect && outcome.state !== "needs_setup")}
            aria-label={t("showAtCheckout", { method: t(method) })}
            onCheckedChange={(on) => {
              if (on && outcome.state === "needs_setup") {
                pendingTurnOn.current = method;
                setupButtons.current.get(method)?.click();
                return;
              }
              toggle(method, on);
            }}
          />
        </label>
      </li>
    );
  });

  return (
    <SettingsCard id="paymentMethods"
      title={t("methodsTitle")}
      description={t("methodsDescription")}
      rows={
        <>
          <ul className="divide-y divide-border">{rows}</ul>
          <div className="border-t border-border px-4 py-4">
            {eligibleDefaults.length > 0 ? (
              <SettingsField id="default-payment-method" label={t("defaultMethod")}>
                <NativeSelect
                  id="default-payment-method"
                  className="max-w-xs"
                  value={values.defaultMethod}
                  disabled={!canEdit}
                  onValueChange={(value) => setValues((draft) => ({ ...draft, defaultMethod: value as MethodKey }))}
                >
                  {eligibleDefaults.map((method) => (
                    <option key={method} value={method}>{t(method)}</option>
                  ))}
                </NativeSelect>
              </SettingsField>
            ) : (
              <p role="alert" className="text-body text-destructive">{t("needOneMethod")}</p>
            )}
          </div>
        </>
      }
    />
  );
}

// ── Checkout payment options (checkout flow: mode + advance) ────────────

export function PaymentOptionsCard() {
  const t = useMessages(paymentsMessages);
  const canEdit = useCanEditPayments();
  const methods = useQuery(paymentMethodsQuery);
  const { codEnabled, online } = usableMethods(methods.data);
  const wholeTaka = useWholeCashAmounts();
  const issuesFor = (draft: CheckoutFlow) =>
    getCheckoutFlowPreviewIssues({
      checkoutMode: draft.checkoutMode,
      partialPaymentEnabled: draft.partialPaymentEnabled,
      partialPaymentAmount: draft.partialPaymentAmount,
      paymentMethodsUnavailable: methods.isError,
      paymentMethodsLoaded: Boolean(methods.data),
      codEnabled,
      activeOnlineMethodCount: online.length,
      sslCommerzEnabled: online.includes("sslcommerz"),
      wholeTaka,
    });
  const { values, setValue, isLoaded, isLoadError, refetch } = useCheckoutFlowForm((draft) => issuesFor(draft).length === 0, t("optionsTitle"));
  if (isLoadError) return <SettingsLoadFailure title={t("loadFlow")} onRetry={refetch} />;
  if (!isLoaded) return <SettingsCardLoading />;

  const issues = issuesFor(values);
  const limits = { min: formatNumber(CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min), max: formatNumber(CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max) };
  const modes = [
    ["all", "modeAll", "modeAllDesc"],
    ["guest_cod_only", "modeCod", "modeCodDesc"],
    ["gateways_only", "modeOnline", "modeOnlineDesc"],
  ] as const;
  return (
    <SettingsCard id="paymentOptions" title={t("optionsTitle")}>
      <RadioGroup
        value={values.checkoutMode}
        disabled={!canEdit}
        onValueChange={(mode) => setValue("checkoutMode", mode as CheckoutFlow["checkoutMode"])}
      >
        {modes.map(([value, label, description]) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-1 text-body">
            <RadioGroupItem value={value} className="mt-0.5" />
            <span>
              <span className="block font-medium">{t(label)}</span>
              <span className="block text-muted-foreground">{t(description)}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <label className="flex min-h-11 items-center justify-between gap-4 border-t border-border pt-4 text-body">
        <span>
          <span className="block font-medium">{t("advance")}</span>
          <span className="block text-muted-foreground">{t("advanceHelp")}</span>
        </span>
        <Switch
          checked={values.partialPaymentEnabled}
          disabled={!canEdit}
          onCheckedChange={(on) => setValue("partialPaymentEnabled", on)}
        />
      </label>
      {values.partialPaymentEnabled ? (
        <SettingsField id="advance-amount" label={t("advanceAmount")} help={t("advanceAmountHelp")}>
          <Input
            id="advance-amount"
            type="number"
            inputMode={wholeTaka ? "numeric" : "decimal"}
            min="0"
            step={wholeTaka ? "1" : "0.01"}
            className="max-w-40"
            value={Number.isFinite(values.partialPaymentAmount) ? values.partialPaymentAmount : ""}
            disabled={!canEdit}
            aria-invalid={issues.includes("amountInvalid") || issues.includes("sslRange") || issues.includes("wholeTaka")}
            aria-describedby="advance-amount-note"
            onChange={(event) => setValue("partialPaymentAmount", Number(event.target.value))}
          />
        </SettingsField>
      ) : null}
      {issues.map((issue) => (
        <p key={issue} role="alert" className="text-body text-destructive">{t(issue, limits)}</p>
      ))}
    </SettingsCard>
  );
}
