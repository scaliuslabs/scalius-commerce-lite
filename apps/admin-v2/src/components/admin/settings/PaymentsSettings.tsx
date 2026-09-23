import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Banknote } from "lucide-react";
import {
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { readCheckoutFlowRevisionConflict } from "~/lib/admin-api-error";
import { apiData, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { paymentsMessages } from "~/i18n/settings-payments";
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
import { SettingsCard, SettingsDialog, SettingsField, SettingsCardLoading } from "./SettingsPage";
import { currencyQuery, platformQuery } from "./StoreSettings";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED = "••••••••••••";
const METHODS: MethodKey[] = ["cod", "sslcommerz", "stripe"];

type CheckoutFlow = ApiResult<typeof getApiV1AdminSettingsCheckoutFlow>;
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
export const gatewayQuery = (gateway: "stripe" | "sslcommerz") => ({
  queryKey: queryKeys.settings.paymentGateway(gateway),
  // One switch per gateway: saving its keys turns the provider on; showing
  // it to buyers is the payment-method switch on the page.
  queryFn: async (): Promise<Record<string, string | boolean>> => ({
    ...(gateway === "stripe"
      ? await apiData(getApiV1AdminSettingsStripe())
      : await apiData(getApiV1AdminSettingsSslcommerz())),
    enabled: true,
  }),
});

function useCanEditPayments() {
  return useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
}

/**
 * The checkout-flow document is revisioned. A stale revision is refused by
 * the server; the form then reloads the latest version and keeps the
 * merchant's edits, so saving again applies them on top (never silently).
 */
export function useCheckoutFlowForm(isValid: (draft: CheckoutFlow) => boolean, label?: string) {
  const queryClient = useQueryClient();
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  return useSettingsForm<CheckoutFlow, CheckoutFlow>({
    label,
    queryKey: checkoutFlowQuery.queryKey,
    fetchFn: checkoutFlowQuery.queryFn,
    saveFn: async (draft) => {
      try {
        return await apiData(putApiV1AdminSettingsCheckoutFlow({
          body: {
            guestCheckoutEnabled: draft.guestCheckoutEnabled,
            checkoutMode: draft.checkoutMode,
            partialPaymentEnabled: draft.partialPaymentEnabled,
            partialPaymentAmount: draft.partialPaymentAmount,
            expectedRevision: draft.revision,
          },
        }));
      } catch (error) {
        if (!readCheckoutFlowRevisionConflict(error)) throw error;
        await queryClient.invalidateQueries({ queryKey: checkoutFlowQuery.queryKey });
        throw new Error(t("conflict"));
      }
    },
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

function PasswordField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  const t = useMessages(paymentsMessages);
  return (
    <SettingsField id={id} label={label} help={value === MASKED ? t("secretSaved") : undefined}>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        aria-describedby={`${id}-note`}
        onFocus={() => value === MASKED && onChange("")}
        onChange={(event) => onChange(event.target.value)}
      />
    </SettingsField>
  );
}

function GatewayFields({ gateway }: { gateway: "stripe" | "sslcommerz" }) {
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  const query = gatewayQuery(gateway);
  const platform = useQuery(platformQuery);
  const { values, setValue } = useSettingsForm<Record<string, string | boolean>>({
    queryKey: query.queryKey,
    fetchFn: query.queryFn,
    saveFn: (draft) =>
      gateway === "stripe"
        ? apiData(postApiV1AdminSettingsStripe({ body: draft }))
        : apiData(postApiV1AdminSettingsSslcommerz({ body: draft })),
    invalidateQueryKeys: [paymentMethodsQuery.queryKey, checkoutFlowQuery.queryKey, queryKeys.settings.checkoutReadiness()],
    defaultValues: {},
    errorMessage: common("saveFailed"),
    canEdit: useCanEditPayments(),
  });
  const text = (key: string) => String(values[key] ?? "");
  if (values.enabled === undefined) return null;

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
        <SettingsField id="ssl-store-id" label={t("storeId")}>
          <Input id="ssl-store-id" autoComplete="off" value={text("storeId")} onChange={(event) => setValue("storeId", event.target.value)} />
        </SettingsField>
        <PasswordField id="ssl-password" label={t("storePassword")} value={text("storePassword")} onChange={(value) => setValue("storePassword", value)} />
      </>
    );
  }

  const environment = getStripeCredentialEnvironment({
    secretKey: text("secretKey"),
    publishableKey: text("publishableKey"),
  });
  return (
    <>
      <PasswordField id="stripe-secret" label={t("secretKey")} value={text("secretKey")} onChange={(value) => setValue("secretKey", value)} />
      <SettingsField
        id="stripe-publishable"
        label={t("publishableKey")}
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
      <PasswordField id="stripe-webhook" label={t("webhookSecret")} value={text("webhookSecret")} onChange={(value) => setValue("webhookSecret", value)} />
      {platform.data?.apiUrl ? (
        <p className="text-body text-muted-foreground">{t("webhookHelp", { url: `${platform.data.apiUrl}/api/v1/webhooks/stripe` })}</p>
      ) : null}
    </>
  );
}

export function PaymentMethodsCard() {
  const t = useMessages(paymentsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanEditPayments();
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
    saveFn: (draft) =>
      apiData(postApiV1AdminSettingsPaymentMethods({
        body: { enabledMethods: draft.enabledMethods, defaultMethod: draft.defaultMethod },
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
    const detail = eligibilityIssue(method)
      ? t("sslNeedsBdt")
      : exclusion
        ? t(exclusion)
        : [
            t(outcome.state),
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
                trigger={
                  <Button type="button" variant="outline" size="sm" disabled={!canEdit}>
                    {outcome.state === "needs_setup" || outcome.state === "provider_off" ? t("set_up") : t("manage")}
                  </Button>
                }
              >
                <GatewayFields gateway={method} />
              </SettingsDialog>
            ) : null}
          </div>
        ) : null}
        {/* A 44px hit area around the small switch (touch target). */}
        <label className="-mx-1 -my-3 flex size-11 items-center justify-center">
          <Switch
            checked={selected}
            disabled={!canEdit || (!selected && !outcome.canSelect)}
            aria-label={t("showAtCheckout", { method: t(method) })}
            onCheckedChange={(on) => toggle(method, on)}
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
                <Select
                  value={values.defaultMethod}
                  disabled={!canEdit}
                  onValueChange={(value) => setValues((draft) => ({ ...draft, defaultMethod: value as MethodKey }))}
                >
                  <SelectTrigger id="default-payment-method" className="max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleDefaults.map((method) => (
                      <SelectItem key={method} value={method}>{t(method)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
    });
  const { values, setValue, isLoadError, refetch } = useCheckoutFlowForm((draft) => issuesFor(draft).length === 0, t("optionsTitle"));
  if (isLoadError) return <SettingsLoadFailure title={t("loadFlow")} onRetry={refetch} />;
  if (values.revision === undefined) return <SettingsCardLoading />;

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
            inputMode="decimal"
            min="0"
            step="0.01"
            className="max-w-40"
            value={Number.isFinite(values.partialPaymentAmount) ? values.partialPaymentAmount : ""}
            disabled={!canEdit}
            aria-invalid={issues.includes("amountInvalid") || issues.includes("sslRange")}
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
