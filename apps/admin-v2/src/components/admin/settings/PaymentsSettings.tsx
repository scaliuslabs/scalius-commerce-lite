import { useRef, useState } from "react";
import { providerLabel, providerSetupReason } from "~/i18n/provider-copy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Banknote, FileText, Wallet } from "lucide-react";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminSettingsStripe,
  getApiV1AdminSettingsCheckoutFlow,
  postApiV1AdminSettingsPaymentMethods,
  postApiV1AdminSettingsProvidersByIdTest,
  postApiV1AdminSettingsStripe,
  putApiV1AdminSettingsCheckoutFlow,
} from "@scalius/api-client/sdk";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { AdminApiResponseError, readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { apiData, type ApiResult } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import {
  checkoutFlowQuery,
  currencyQuery,
  gatewayQuery,
  paymentMethodsQuery,
  platformQuery,
  type GatewayValues,
  type PaymentMethods,
} from "~/lib/api-query-options/settings-screens";
import { appPaymentProvidersQuery } from "~/lib/api-query-options/payment-providers";
import { queryKeys } from "~/lib/query-keys";
import { marketCurrenciesQueryOptions } from "~/lib/api-query-options/markets";
import { formatList } from "@scalius/shared/locale-words";
import { formatNumber, getLocale, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { paymentsMessages } from "~/i18n/settings-payments";
import { saveBarMessages } from "~/i18n/save-bar";
import {
  getCheckoutFlowPreviewIssues,
  violatedAdvanceLimit,
  type AdvanceAmountLimit,
} from "./checkout-flow-policy";
import {
  chargeCurrencyIssue,
  getEligibleDefaultPaymentMethods,
  getPaymentMethodFlowEligibility,
  getPaymentMethodFlowExclusionReason,
  getPaymentMethodOutcome,
  type MethodKey,
} from "./payment-method-outcome";
import { COD_METHOD, NET_TERMS_METHOD, paymentMethodRows, type PaymentMethodRow } from "./payment-method-rows";
import { NetTermsPanel } from "./NetTermsPanel";
import { DEFAULT_NET_TERMS_SETTINGS, netTermsNamesAnyone, type NetTermsSettings } from "@scalius/shared/payment-terms";
import { OfficialProviderMark, PROVIDER_MARKS, type ProviderMarkId } from "./provider-marks";
import { AppIcon } from "~/components/admin/apps/AppIcon";
import { appProviderSetupPath } from "~/components/admin/apps/app-sections";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useWholeUnitPrices } from "../shared/MoneyInput";
import { ProvidedByChip } from "./AppProviderStatus";
import { SettingsCard, SettingsDialog, SettingsField, SettingsCardLoading, useCloseSettingsDialog } from "./SettingsPage";

/** Saved secrets come back masked; sending the mask back keeps them. */
const MASKED = "••••••••••••";

type CheckoutFlow = Omit<ApiResult<typeof getApiV1AdminSettingsCheckoutFlow>, "revision">;
type GatewayKey = "secretKey" | "publishableKey" | "webhookSecret";
/**
 * Every key a built-in gateway needs before it can be turned on, and the
 * field showing it. Other gateways are apps' (SSLCommerz: the Bangladesh
 * pack's), set up in their provider sheet.
 */
const GATEWAY_KEYS: Record<"stripe", Partial<Record<GatewayKey, string>>> = {
  stripe: { secretKey: "stripe-secret", publishableKey: "stripe-publishable", webhookSecret: "stripe-webhook" },
};

/** "publishable key and webhook secret", in the dashboard language. */
function useKeyList() {
  const t = useMessages(paymentsMessages);
  return (keys: readonly string[]) =>
    formatList(keys.map((key) => t(`key_${key as GatewayKey}`)), getLocale());
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
          requireFullBillingAddress: draft.requireFullBillingAddress,
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
    return status?.usable ?? (status?.enabled === true && status?.configured === true);
  };
  const enabled = methods?.enabledMethods.filter(usable) ?? [];
  return {
    codEnabled: enabled.includes(COD_METHOD),
    online: enabled.filter((method) => method !== COD_METHOD),
  };
}

// ── Payment methods ─────────────────────────────────────────────────────

function MethodMark({ row }: { row: PaymentMethodRow }) {
  if (row.kind === "built_in" && row.id in PROVIDER_MARKS) {
    return <OfficialProviderMark provider={row.id as ProviderMarkId} />;
  }
  // An app's provider shows its own mark (SSLCommerz in the Bangladesh pack), else its app's icon (bKash, Nagad).
  if (row.kind === "app" && row.appIcon) return <AppIcon src={row.appIcon} size="sm" />;
  // Cash, or an app without an icon: a neutral mark.
  const Icon = row.kind === "cod" ? Banknote : row.kind === "invoice" ? FileText : Wallet;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
      <Icon className="size-5" />
    </span>
  );
}

/** The invoice's readiness in the card's terms: ready once it names who may pay by it. */
function invoiceStatus(netTerms: NetTermsSettings) {
  const named = netTermsNamesAnyone(netTerms);
  return {
    configured: named,
    enabled: true,
    usable: named,
    missingFields: named ? [] : ["netTerms.customerTags"],
    providerEnabled: true,
    environment: "not_applicable" as const,
  };
}

/** The built-in gateway whose keys this page edits. */
function hasKeyForm(id: string): id is keyof typeof GATEWAY_KEYS {
  return Object.hasOwn(GATEWAY_KEYS, id);
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
  gateway: "stripe";
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
      const result = await apiData(postApiV1AdminSettingsStripe({ body }));
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
function RemoveKeys({ gateway, revision }: { gateway: "stripe"; revision: number }) {
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
    mutationFn: () => apiData(deleteApiV1AdminSettingsStripe({ body: { expectedRevision: revision } })),
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
      <Button type="button" variant="ghost" className="-ms-3" onClick={() => setConfirming(true)}>
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
  const queryClient = useQueryClient();
  // Flipping on a gateway that still needs keys opens its setup to finish it.
  const [turningOn, setTurningOn] = useState<MethodKey | null>(null);
  const pendingTurnOn = useRef<MethodKey | null>(null);
  const setupButtons = useRef(new Map<MethodKey, HTMLButtonElement>());
  const canViewApps = useHasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const flow = useQuery(checkoutFlowQuery);
  const currency = useQuery(currencyQuery);
  const marketCurrencies = useQuery(marketCurrenciesQueryOptions());
  // Installed apps' providers, offered or not; without them the active ones still list.
  const appProviders = useQuery({ ...appPaymentProvidersQuery, enabled: useProviderPortAccess("payment").canView });
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const connectionTest = useMutation({
    mutationFn: (id: string) => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id } })),
    onSuccess: (result, id) => setTestResults((current) => ({ ...current, [id]: result })),
    onError: (error, id) => setTestResults((current) => ({ ...current, [id]: { ok: false, message: getServerFnError(error) } })),
    // The outcome is kept: the providers list reads it back for each row.
    onSettled: () => queryClient.invalidateQueries({ queryKey: appPaymentProvidersQuery.queryKey }),
  });
  // The form validates its empty defaults before the first read too. The
  // invoice is ready once the draft names who may pay by it.
  const rowsFor = (draft: PaymentMethods) =>
    paymentMethodRows({
      enabledMethods: draft.enabledMethods ?? [],
      gateways: draft.gateways ?? [],
      gatewayStatus: { ...draft.gatewayStatus, [NET_TERMS_METHOD]: invoiceStatus(draft.netTerms ?? DEFAULT_NET_TERMS_SETTINGS) },
      appProviders: appProviders.data ?? [],
      appProvidersKnown: appProviders.isSuccess,
    });
  const flowAllowed = (method: MethodKey) =>
    flow.data ? getPaymentMethodFlowEligibility(method, flow.data) : undefined;
  // Fail closed: a gateway restricted to some currencies needs the store's to be one.
  const currencyIssue = (draft: PaymentMethods, method: MethodKey) =>
    chargeCurrencyIssue(draft.gateways?.find((gateway) => gateway.id === method)?.chargeCurrencies ?? "any", currency.data?.currencyCode);
  const defaults = (draft: PaymentMethods) =>
    getEligibleDefaultPaymentMethods({
      methods: rowsFor(draft).map((row) => row.id),
      statuses: draft.gatewayStatus,
      selectedMethods: new Set(draft.enabledMethods),
      flowAllowed,
      eligibilityIssue: (method) => (currencyIssue(draft, method) ? "currency" : null),
    });
  // What Save names when the methods can't be saved (the default select is marked too).
  const problems = (draft: PaymentMethods) => {
    const options = defaults(draft);
    if (options.length === 0) return [{ message: t("needOneMethod") }];
    return options.includes(draft.defaultMethod) ? [] : [{ message: t("chooseDefault"), target: "default-payment-method" }];
  };
  const { values, savedValues, setValues, isLoadError, refetch } = useSettingsForm<PaymentMethods>({
    label: t("methodsTitle"),
    queryKey: paymentMethodsQuery.queryKey,
    fetchFn: paymentMethodsQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(postApiV1AdminSettingsPaymentMethods({
        body: {
          enabledMethods: draft.enabledMethods,
          defaultMethod: draft.defaultMethod,
          ...(draft.netTerms ? { netTerms: draft.netTerms } : {}),
          expectedRevision,
        },
      })),
    invalidateQueryKeys: [checkoutFlowQuery.queryKey, queryKeys.settings.checkoutReadiness()],
    defaultValues: {} as PaymentMethods,
    errorMessage: common("saveFailed"),
    canEdit,
    // Fail closed: without the saved flow and currency, visibility is unknown.
    isValid: () => Boolean(flow.data && currency.data),
    problems: (draft) => (flow.data && currency.data ? problems(draft) : []),
  });
  if (isLoadError || flow.isError || currency.isError) {
    return <SettingsLoadFailure title={t("loadMethods")} onRetry={() => Promise.all([refetch(), flow.refetch(), currency.refetch()])} />;
  }
  if (!values.enabledMethods) return <SettingsCardLoading />;

  // Currency badges only once a market sells in its own currency: a one-currency store sees none.
  const multiCurrency = (marketCurrencies.data?.marketCurrencies.length ?? 0) > 0;
  const eligibleDefaults = defaults(values);
  const methodRows = rowsFor(values);
  // Built-in methods read in the dashboard language; an app's provider by its own name.
  const nameOf = (row: PaymentMethodRow) =>
    row.kind !== "app" && Object.hasOwn(paymentsMessages.en, row.id) ? t(row.id as keyof typeof paymentsMessages.en) : providerLabel(row.name);
  const names = new Map(methodRows.map((row) => [row.id, nameOf(row)]));
  const currencyText = (currencies: readonly string[]) =>
    currencies.length === 1 && currencies[0] === "BDT"
      ? t("needsTaka")
      : t("needsCurrency", { currencies: formatList(currencies, getLocale(), "disjunction") });
  const toggle = (method: MethodKey, on: boolean) =>
    setValues((draft) => {
      const enabledMethods = draft.enabledMethods.filter((item) => item !== method);
      if (on) {
        // Checkout uses this order. Re-enabling a saved method restores its position.
        const savedPosition = savedValues.enabledMethods.indexOf(method);
        enabledMethods.splice(savedPosition < 0 ? enabledMethods.length : savedPosition, 0, method);
      }
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

  const rows = methodRows.map((row) => {
    const method = row.id;
    const name = nameOf(row);
    const status = row.status;
    const selected = values.enabledMethods.includes(method);
    const neededCurrencies = currencyIssue(values, method);
    const invoiceRow = row.kind === "invoice";
    const outcome = getPaymentMethodOutcome({
      method,
      status,
      checkoutSelected: selected,
      flowAllowed: flowAllowed(method),
      eligibilityIssue: neededCurrencies ? "currency" : null,
    });
    const environment = status?.environment;
    const exclusion = flow.data && outcome.state === "hidden_by_flow" ? getPaymentMethodFlowExclusionReason(method, flow.data) : null;
    const missingKeys = status?.missingFields ?? [];
    const keyForm = row.kind === "built_in" && hasKeyForm(method) ? method : null;
    // Only the built-in key forms name missing keys; an app explains itself (blockedReason).
    const needsKeys = keyForm !== null && outcome.state === "needs_setup" && missingKeys.length > 0;
    const unusable = outcome.state === "needs_setup" || outcome.state === "provider_off" || outcome.state === "blocked";
    const detail = neededCurrencies
      ? currencyText(neededCurrencies)
      : exclusion
        ? t(exclusion)
        : invoiceRow
          ? [t("netTermsSummary", { days: formatNumber(values.netTerms?.dueInDays ?? DEFAULT_NET_TERMS_SETTINGS.dueInDays) }), t(outcome.state === "needs_setup" ? "netTermsNeedsPeople" : outcome.state)].join(" · ")
        : row.kind === "app" && unusable && status?.blockedReason
          ? providerSetupReason(status.blockedReason)
          : [
              needsKeys ? t("needsKeys", { fields: keyList(missingKeys) }) : t(outcome.state),
              method !== "cod" && environment === "test" ? t("testMode") : null,
              // "Ready" needs a passing connection test where the app offers one; it never runs on load.
              outcome.state === "visible" && row.connection?.status === "untested" ? t("notTested") : null,
              outcome.state === "visible" && row.connection?.status === "failed" ? t("testFailed") : null,
              method !== "cod" && environment === "mixed" ? t("keyMismatch") : null,
            ].filter(Boolean).join(" · ");
    const position = values.enabledMethods.indexOf(method);
    const reorderable = selected && values.enabledMethods.length > 1;
    // Flipping on a built-in gateway that still needs keys opens its setup;
    // the invoice turns on and opens its settings below the row.
    const turnsOnThroughSetup = (keyForm !== null || invoiceRow) && outcome.state === "needs_setup";
    const testResult = testResults[method];
    const testing = connectionTest.isPending && connectionTest.variables === method;
    const appActions = row.kind === "app" ? (
      <>
        {row.canTestConnection && status?.usable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit || (connectionTest.isPending && !testing)}
            loading={testing}
            onClick={() => connectionTest.mutate(method)}
          >
            {t("testConnection")}
          </Button>
        ) : null}
        {/* Its feature's page in the app: the switch, consent and the provider's own keys. */}
        {canViewApps && row.pluginId ? (
          <Button asChild variant="outline" size="sm">
            <Link to={appProviderSetupPath(method)}>{unusable ? t("set_up") : t("manage")}</Link>
          </Button>
        ) : null}
      </>
    ) : null;
    const hasActions = reorderable || keyForm !== null || (row.kind === "app" && ((row.canTestConnection && status?.usable) || (canViewApps && row.pluginId)));
    return (
      <li key={method} data-method={method} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <MethodMark row={row} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body font-medium">
            {name}
            {/* Which currencies it charges (MARKETS-DESIGN step 6): a market in another currency doesn't offer it. */}
            {multiCurrency ? (
              <Badge variant="secondary" title={t("chargesCurrenciesHelp")}>
                {method === "cod"
                  ? t("cashCurrency")
                  : row.chargeCurrencies === "any"
                    ? t("chargesAny")
                    : t("chargesCurrencies", { currencies: formatList(row.chargeCurrencies, getLocale(), "conjunction") })}
              </Badge>
            ) : null}
          </p>
          {row.kind === "app" && row.appName && row.pluginId ? (
            <ProvidedByChip pluginId={row.pluginId} appName={row.appName} />
          ) : row.kind === "app" && row.appName ? (
            <p className="text-body text-muted-foreground">{t("fromApp", { app: providerLabel(row.appName) })}</p>
          ) : null}
          <p className="text-body text-muted-foreground">{detail}</p>
          {testResult ? (
            <p role="status" className={cn("text-body", testResult.ok ? "text-success" : "text-destructive")}>
              {[t(testResult.ok ? "testWorked" : "testFailed"), testResult.message].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
        {hasActions ? (
          // Secondary actions wrap under the name on phones.
          <div className="order-last flex w-full flex-wrap items-center gap-1 sm:order-none sm:w-auto">
            {reorderable ? (
              <>
                <Button type="button" variant="ghost" size="icon" disabled={!canEdit || position === 0} aria-label={t("moveUp", { method: name })} onClick={() => move(method, -1)}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon" disabled={!canEdit || position === values.enabledMethods.length - 1} aria-label={t("moveDown", { method: name })} onClick={() => move(method, 1)}>
                  <ArrowDown aria-hidden="true" />
                </Button>
              </>
            ) : null}
            {appActions}
            {keyForm !== null ? (
              <SettingsDialog
                title={t("credentialsTitle", { method: name })}
                description={turningOn === method && needsKeys ? t("turnOnNeeds", { fields: keyList(missingKeys), method: name }) : undefined}
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
                  gateway={keyForm}
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
            // Fail closed: a method that can't be used can only be turned off.
            disabled={!canEdit || (!selected && !outcome.canSelect && !turnsOnThroughSetup)}
            aria-label={t("showAtCheckout", { method: name })}
            onCheckedChange={(on) => {
              if (invoiceRow) {
                toggle(method, on);
                return;
              }
              if (on && turnsOnThroughSetup) {
                pendingTurnOn.current = method;
                setupButtons.current.get(method)?.click();
                return;
              }
              toggle(method, on);
            }}
          />
        </label>
        {invoiceRow && selected ? (
          <NetTermsPanel
            value={values.netTerms ?? DEFAULT_NET_TERMS_SETTINGS}
            disabled={!canEdit}
            onChange={(netTerms) => setValues((draft) => ({ ...draft, netTerms }))}
          />
        ) : null}
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
              <SettingsField
                id="default-payment-method"
                label={t("defaultMethod")}
                error={eligibleDefaults.includes(values.defaultMethod) ? undefined : t("chooseDefault")}
              >
                <SearchableSelect
                  id="default-payment-method"
                  triggerClassName="max-w-xs"
                  value={values.defaultMethod}
                  disabled={!canEdit}
                  onValueChange={(value) => setValues((draft) => ({ ...draft, defaultMethod: value as MethodKey }))}
                  options={eligibleDefaults.map((method) => ({ value: method, label: names.get(method) ?? method }))}
                />
              </SettingsField>
            ) : (
              <p role="alert" className="text-body text-destructive">{t("needOneMethod")}</p>
            )}
            {appProviders.isError ? (
              <p className="mt-2 text-body text-muted-foreground">{t("appsLoadFailed")}</p>
            ) : null}
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
  // The charge limits of the online methods checkout offers (SSLCommerz: 10 to 500,000 Taka).
  const advanceLimits: AdvanceAmountLimit[] = online.flatMap((method) => {
    const limits = methods.data?.gateways.find((gateway) => gateway.id === method)?.amountLimits;
    return limits ? [{ method, ...limits }] : [];
  });
  const wholeTaka = useWholeUnitPrices();
  const issuesFor = (draft: CheckoutFlow) =>
    getCheckoutFlowPreviewIssues({
      checkoutMode: draft.checkoutMode,
      partialPaymentEnabled: draft.partialPaymentEnabled,
      partialPaymentAmount: draft.partialPaymentAmount,
      paymentMethodsUnavailable: methods.isError,
      paymentMethodsLoaded: Boolean(methods.data),
      codEnabled,
      activeOnlineMethodCount: online.length,
      advanceLimits,
      wholeTaka,
    });
  const { values, setValue, isLoaded, isLoadError, refetch } = useCheckoutFlowForm((draft) => issuesFor(draft).length === 0, t("optionsTitle"));
  if (isLoadError) return <SettingsLoadFailure title={t("loadFlow")} onRetry={refetch} />;
  if (!isLoaded) return <SettingsCardLoading />;

  const issues = issuesFor(values);
  // The first offered method whose limits the advance misses words the range message.
  const violated = violatedAdvanceLimit(values.partialPaymentAmount, advanceLimits);
  const methodName = (id: string) => methods.data?.gateways.find((gateway) => gateway.id === id)?.label ?? id;
  const limits: Record<string, string> = violated
    ? {
        method: methodName(violated.method),
        min: formatNumber(violated.min),
        max: formatNumber(violated.max),
        currency: violated.currency === "BDT" ? t("taka") : violated.currency,
      }
    : {};
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
            <span className="flex h-lh items-center"><RadioGroupItem value={value}/></span>
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
            aria-invalid={issues.includes("amountInvalid") || issues.includes("advanceRange") || issues.includes("wholeTaka")}
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
