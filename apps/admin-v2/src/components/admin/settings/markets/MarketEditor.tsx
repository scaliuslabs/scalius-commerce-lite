// One market (docs/MARKETS-DESIGN.md D4), Shopify's market page: its name
// and status, Countries, Currency (the store's currency, or the market's own
// with its manual exchange rate and rate lock, step 6), Pricing (Shopify's
// price adjustment, another market only) and Taxes. The primary market also
// has the price format. Rarely changed controls (the handle, and another
// market's own web address and language) sit behind "Web address and
// handle". One save bar saves the page under the revision it loaded; the
// delete action sits apart at the bottom.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { getDecimalPlaces, SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency";
import { currencySymbol, formatAmount, moneyLocale } from "@scalius/shared/money-format";
import { marketCurrencyIncrementMinor } from "@scalius/shared/presentment";
import {
  cashOnDeliveryIncrementMinor,
  isWholeUnitIncrement,
  priceIncrementChoices,
  resolvePriceIncrementMinor,
} from "@scalius/shared/currency-policy";
import { MARKET_HANDLE_MAX_LENGTH, MARKET_NAME_MAX_LENGTH } from "@scalius/shared/markets";
import { toast } from "~/lib/toast";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { formatDateTime, formatNumber, getLocale, useLocale, useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { settingsMarketsMessages } from "~/i18n/settings-markets";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import { isAdminApiNotFoundError } from "~/lib/admin-api-error";
import { storeLanguagesQueryOptions } from "~/lib/api-query-options/translations";
import { languageName } from "../../translations/translation-form";
import { marketCurrenciesQueryOptions, marketWriteInvalidations, marketsQueryOptions, saveMarket, useDeleteMarket } from "~/lib/api-query-options/markets";
import { SettingsAdvanced, SettingsCard, SettingsCardLoading, SettingsField, SettingsPage } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { MarketCountryPicker } from "./MarketCountryPicker";
import {
  EMPTY_MARKET_FORM,
  adjustedPricePreview,
  endingChoices,
  roundingChoices,
  sellsOwnCurrency,
  countriesTakenByOthers,
  fetchMarketForm,
  marketEditorQueryOptions,
  marketForm,
  marketFormProblems,
  marketUpdateBody,
  presencePath,
  withSubfolder,
  type MarketForm,
} from "./market-form";

function displayName(code: string, type: "currency"): string {
  try {
    return new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function MarketEditor({ marketId }: { marketId: string }) {
  const t = useMessages(settingsMarketsMessages);
  const nav = useMessages(settingsNavMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const editor = marketEditorQueryOptions(marketId);
  const saved = useQuery(editor);
  const markets = useQuery(marketsQueryOptions());
  const form = useSettingsForm<MarketForm, MarketForm & { revision: number }>({
    queryKey: editor.queryKey,
    fetchFn: () => fetchMarketForm(marketId),
    saveFn: async (draft, expectedRevision) => marketForm(await saveMarket(marketId, marketUpdateBody(draft, expectedRevision))),
    resolveSavedValues: (result) => result,
    defaultValues: EMPTY_MARKET_FORM,
    invalidateQueryKeys: marketWriteInvalidations(),
    isValid: (draft) => Object.keys(marketFormProblems(draft)).length === 0,
    canEdit,
    errorMessage: common("saveFailed"),
    label: t("detailsTitle"),
    fields: { name: "market-name", handle: "market-handle", countries: "market-countries", presence: "market-suffix", currencyCode: "market-currency", fxRate: "market-rate", fxLockMinutes: "market-lock", priceAdjustmentPercent: "market-adjustment", priceRounding: "market-rounding", priceEnding: "market-ending" },
  });
  const back = { to: "/admin/settings/markets" as const, label: nav("markets") };

  if (form.isLoadError) {
    const missing = isAdminApiNotFoundError(form.loadError);
    return (
      <SettingsPage page="markets" back={back} title={nav("markets")}>
        {missing ? <SettingsCard description={t("notFound")} /> : <SettingsLoadFailure title={t("loadFailed")} onRetry={form.refetch} />}
      </SettingsPage>
    );
  }
  if (!form.isLoaded || !saved.data) {
    return (
      <SettingsPage page="markets" back={back} title={nav("markets")}>
        <SettingsCardLoading />
      </SettingsPage>
    );
  }

  const { values, setValue, setValues } = form;
  const problems = marketFormProblems(values);
  const taken = countriesTakenByOthers(markets.data, marketId);
  // The backup market's increment: what a market in the shop currency prices at.
  const backupIncrement = markets.data?.find((market) => market.isBackup)?.priceIncrementMinor ?? values.priceIncrementMinor;
  const savedStatus = saved.data.status;
  return (
    <SettingsPage
      page="markets"
      back={back}
      title={saved.data.name}
      readOnly={!canEdit}
      actions={
        <span className="flex items-center gap-2">
          {saved.data.isBackup ? <Badge variant="info">{t("primary")}</Badge> : null}
          <StatusBadge status={savedStatus}>{t(savedStatus)}</StatusBadge>
        </span>
      }
    >
      <SettingsCard title={t("detailsTitle")}>
        <SettingsField id="market-name" label={t("name")} help={t("nameHelp")} error={problems.name ? t(problems.name) : null}>
          <Input id="market-name" value={values.name} maxLength={MARKET_NAME_MAX_LENGTH} disabled={!canEdit} onChange={(event) => setValue("name", event.target.value)} />
        </SettingsField>
        {values.isBackup ? (
          <p className="text-body text-muted-foreground">{t("primaryAlwaysActive")}</p>
        ) : (
          <RadioGroup
            aria-label={t("status")}
            value={values.status}
            disabled={!canEdit}
            onValueChange={(status) => setValue("status", status === "active" ? "active" : "draft")}
          >
            {(["active", "draft"] as const).map((status) => (
              <label key={status} className="flex min-h-11 items-start gap-2 py-2 text-body">
                <span className="flex h-lh items-center"><RadioGroupItem value={status} /></span>
                <span>
                  <span className="block font-medium">{t(status)}</span>
                  <span className="block text-muted-foreground">{t(status === "active" ? "activeHelp" : "draftHelp")}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
      </SettingsCard>

      <SettingsCard title={t("countries")} description={t(values.isBackup ? "primaryCountriesHelp" : "countriesHelp")}>
        <MarketCountryPicker
          id="market-countries"
          selected={values.countries}
          taken={taken}
          disabled={!canEdit}
          invalid={Boolean(problems.countries)}
          describedBy={problems.countries ? "market-countries-note" : undefined}
          onChange={(countries) => setValue("countries", countries)}
        />
        {problems.countries ? <p id="market-countries-note" role="alert" className="text-body text-destructive">{t(problems.countries)}</p> : null}
      </SettingsCard>

      <CurrencyCard values={values} savedCurrency={saved.data.currencyCode} canEdit={canEdit} rateError={problems.rate ? t(problems.rate) : null} lockError={problems.lock ? t(problems.lock) : null} setValues={setValues} />

      {values.isBackup ? (
        <PriceFormatCard values={values} canEdit={canEdit} onChange={(priceIncrementMinor) => setValue("priceIncrementMinor", priceIncrementMinor)} />
      ) : (
        <PricingCard values={values} canEdit={canEdit} backupIncrement={backupIncrement} adjustmentError={problems.adjustment ? t(problems.adjustment) : null} setValues={setValues} />
      )}

      <SettingsCard title={t("taxesTitle")}>
        <label className="flex min-h-11 items-center justify-between gap-4 text-body">
          <span>
            <span className="block font-medium">{t("pricesIncludeTax")}</span>
            <span className="block text-muted-foreground">{t("pricesIncludeTaxHelp")}</span>
          </span>
          <Switch checked={values.pricesIncludeTax} disabled={!canEdit} onCheckedChange={(on) => setValue("pricesIncludeTax", on)} />
        </label>
        <Link to="/admin/settings/taxes" className="text-body text-foreground underline">{t("taxRegionsLink")}</Link>
      </SettingsCard>

      <SettingsAdvanced label={t("advancedTitle")} forceOpen={Boolean(problems.handle || problems.suffix)}>
        <SettingsCard title={t("handleTitle")}>
          <SettingsField id="market-handle" label={t("handle")} help={t("handleHelp")} error={problems.handle ? t(problems.handle) : null}>
            <Input id="market-handle" value={values.handle} maxLength={MARKET_HANDLE_MAX_LENGTH} disabled={!canEdit} onChange={(event) => setValue("handle", event.target.value)} />
          </SettingsField>
        </SettingsCard>
        {values.isBackup ? null : (
          <WebAddressCard values={values} canEdit={canEdit} suffixError={problems.suffix ? t(problems.suffix) : null} setValues={setValues} />
        )}
      </SettingsAdvanced>

      {!saved.data.isBackup && canEdit ? <DeleteMarket id={marketId} name={saved.data.name} revision={saved.data.revision} hasOrders={saved.data.hasOrders} /> : null}
    </SettingsPage>
  );
}

/** An amount of any currency in the dashboard language: its symbol, then its digits. */
function money(code: string, minor: number): string {
  const places = getDecimalPlaces(code);
  return `${minor < 0 ? "-" : ""}${currencySymbol(code)}${formatAmount(Math.abs(minor) / 10 ** places, moneyLocale(code, getLocale()), places)}`;
}

/**
 * The currency buyers pay in (Shopify's market currency): the shop currency,
 * or the market's own with its manual exchange rate (1 shop unit = rate
 * market units) and the minutes a placed order keeps it. The backup market
 * always sells in the shop currency. The API refuses a currency no active
 * payment method charges, with the reason.
 */
function CurrencyCard({ values, savedCurrency, canEdit, rateError, lockError, setValues }: {
  values: MarketForm;
  savedCurrency: string;
  canEdit: boolean;
  rateError: string | null;
  lockError: string | null;
  setValues: (update: (draft: MarketForm) => MarketForm) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const currencies = useQuery({ ...marketCurrenciesQueryOptions(), enabled: !values.isBackup });
  if (values.isBackup) {
    return (
      <SettingsCard title={t("currencyTitle")}>
        <p className="text-body">{displayName(values.currencyCode, "currency")} ({values.currencyCode})</p>
        <p className="text-body text-muted-foreground">
          {t("currencyLocked")}{" "}
          <Link to="/admin/settings/store" hash="storeDefaults" className="text-foreground underline">{t("storeDetails")}</Link>.
        </p>
      </SettingsCard>
    );
  }
  const shop = values.shopCurrencyCode;
  const own = sellsOwnCurrency(values);
  // Only currencies an active payment method charges (the saved one stays listed).
  const chargeable = currencies.data?.chargeable;
  const others = (chargeable === "any" ? [...SUPPORTED_CURRENCY_CODES] : chargeable ?? [])
    .filter((code) => code !== shop);
  if (own && !others.includes(values.currencyCode)) others.unshift(values.currencyCode);
  if (currencies.isSuccess && others.length === 0) {
    // Nothing else can be charged: the market simply sells in the shop currency.
    return (
      <SettingsCard title={t("currencyTitle")}>
        <p className="text-body">{displayName(shop, "currency")} ({shop})</p>
        <p className="text-body text-muted-foreground">
          {t("noOtherCurrency", { currency: shop })}{" "}
          <Link to="/admin/settings/payments" className="text-foreground underline">{t("paymentsLink")}</Link>.
        </p>
      </SettingsCard>
    );
  }
  const options = [
    { value: shop, label: t("shopCurrencyOption", { currency: `${displayName(shop, "currency")} (${shop})` }), keywords: [shop] },
    ...others.map((code) => ({
      value: code,
      label: `${displayName(code, "currency")} (${code} ${currencySymbol(code)})`,
      keywords: [code],
    })),
  ];
  return (
    <SettingsCard title={t("currencyTitle")}>
      <SettingsField id="market-currency" label={t("currencyLabel")} help={t("currencyHelp", { currency: shop })}>
        <SearchableSelect
          id="market-currency"
          value={values.currencyCode}
          disabled={!canEdit}
          triggerClassName="block w-full sm:w-80"
          options={options}
          onValueChange={(currencyCode) => setValues((draft) => ({
            ...draft,
            currencyCode,
            // A new currency starts without a rate, a step or an ending of the old one.
            fxRate: currencyCode === draft.currencyCode ? draft.fxRate : null,
            priceRoundingMinor: currencyCode === draft.currencyCode ? draft.priceRoundingMinor : null,
            priceEndingMinor: currencyCode === draft.currencyCode ? draft.priceEndingMinor : null,
            priceMode: currencyCode !== draft.shopCurrencyCode ? "fx" : draft.priceMode,
          }))}
        />
      </SettingsField>
      {values.currencyCode !== savedCurrency ? <p className="text-body text-muted-foreground">{t("currencyChangeNote")}</p> : null}
      {own ? (
        <>
          <p className="text-body text-muted-foreground">{t("ownCurrencyNote", { currency: values.currencyCode, shop })}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField id="market-rate" label={t("exchangeRate")} help={t("exchangeRateHelp", { currency: values.currencyCode, shop })} error={rateError}>
              <Input
                id="market-rate"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={values.fxRate ?? ""}
                disabled={!canEdit}
                className="max-w-48"
                onChange={(event) => {
                  const fxRate = event.target.value.trim();
                  setValues((draft) => ({ ...draft, fxRate: fxRate || null }));
                }}
              />
            </SettingsField>
            <SettingsField id="market-lock" label={t("rateLock")} help={t("rateLockHelp")} error={lockError}>
              <NumberInput
                id="market-lock"
                className="max-w-32"
                disabled={!canEdit}
                value={values.fxLockMinutes}
                onValueChange={(fxLockMinutes) => setValues((draft) => ({ ...draft, fxLockMinutes }))}
              />
            </SettingsField>
          </div>
          {values.fxRate && !rateError ? (
            <p className="text-body">
              {t("exchangeRateLine", { shop, rate: values.fxRate, currency: values.currencyCode })}
              {values.fxRateAsOf && values.currencyCode === savedCurrency
                ? <span className="text-muted-foreground"> · {t("rateSetAt", { date: formatDateTime(new Date(values.fxRateAsOf), { dateStyle: "medium" }) })}</span>
                : null}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

/**
 * A market's own web address (a subfolder such as /en-in): its pages,
 * sitemaps and product feeds, in one of the store's languages. The language
 * is asked only when the store has more than one.
 */
function WebAddressCard({ values, canEdit, suffixError, setValues }: {
  values: MarketForm;
  canEdit: boolean;
  suffixError: string | null;
  setValues: (update: (draft: MarketForm) => MarketForm) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const locale = useLocale();
  const storeLanguages = useQuery(storeLanguagesQueryOptions()).data;
  // The store's languages; a market already in another one keeps it.
  const codes = [...new Set([...(storeLanguages ?? []).map((language) => language.locale), values.locale])];
  const path = presencePath(values);
  return (
    <SettingsCard title={t("addressTitle")}>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("useAddress")}</span>
          <span className="block text-muted-foreground">{t(values.subfolder ? "addressHelp" : "noAddressHelp")}</span>
        </span>
        <Switch checked={values.subfolder} disabled={!canEdit} onCheckedChange={(on) => setValues((draft) => withSubfolder(draft, on))} />
      </label>
      {values.subfolder ? (
        <>
          {codes.length > 1 ? (
            <SettingsField id="market-language" label={t("language")} help={t("languageHelp")}>
              <SearchableSelect
                id="market-language"
                value={values.locale}
                disabled={!canEdit}
                triggerClassName="block w-full sm:w-64"
                options={codes.map((code) => ({ value: code, label: languageName(code, locale), keywords: [code] }))}
                onValueChange={(next) => setValues((draft) => ({ ...draft, locale: next }))}
              />
            </SettingsField>
          ) : null}
          <SettingsField id="market-suffix" label={t("suffix")} help={t("suffixHelp")} error={suffixError}>
            <Input
              id="market-suffix"
              value={values.suffix}
              maxLength={2}
              autoCapitalize="none"
              spellCheck={false}
              disabled={!canEdit}
              className="max-w-24"
              onChange={(event) => {
                const suffix = event.target.value.toLowerCase();
                setValues((draft) => ({ ...draft, suffix }));
              }}
            />
          </SettingsField>
          {path && !suffixError ? <p className="text-body">{t("address")}: <code>{path}</code></p> : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

/**
 * The primary market's price format (MARKETS-DESIGN D1): whole units or minor
 * units, used by every market in the store's currency. Only a currency with
 * decimals has the choice, so other stores see no card. Cash on delivery in
 * BDT collects whole taka whatever is chosen, so a taka store that prices in
 * paisa is told so.
 */
function PriceFormatCard({ values, canEdit, onChange }: {
  values: MarketForm;
  canEdit: boolean;
  onChange: (priceIncrementMinor: number) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const code = values.currencyCode;
  const choices = priceIncrementChoices(code);
  if (choices.length < 2) return null;
  const whole = isWholeUnitIncrement(code, resolvePriceIncrementMinor(code, values.priceIncrementMinor));
  const takaCash = cashOnDeliveryIncrementMinor(code) > 1 && !whole;
  return (
    <SettingsCard title={t("formatTitle")}>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("wholePricesLabel")}</span>
          <span className="block text-muted-foreground">{t("wholePricesHelp")}</span>
          {takaCash ? <span className="block text-muted-foreground">{t("wholePricesCod")}</span> : null}
        </span>
        <Switch
          checked={whole}
          disabled={!canEdit}
          onCheckedChange={(on) => onChange(on ? choices[choices.length - 1]! : choices[0]!)}
        />
      </label>
    </SettingsCard>
  );
}

/** Product prices in a market's own sample amounts (minor units of a whole-unit price: 499, 1,299 and 2,450). */
const PREVIEW_UNITS = [499, 1_299, 2_450];

/**
 * How a market prices (MARKETS-DESIGN D5), Shopify's price adjustment: the
 * product prices, or the product prices raised or lowered by a percentage,
 * rounded up to a step and ending in an amount, with a live preview. Price
 * lists win over both; the card links to them.
 */
function PricingCard({ values, canEdit, backupIncrement, adjustmentError, setValues }: {
  values: MarketForm;
  canEdit: boolean;
  /** The backup market's increment: a market in the shop currency prices at it. */
  backupIncrement: number;
  adjustmentError: string | null;
  setValues: (update: (draft: MarketForm) => MarketForm) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const own = sellsOwnCurrency(values);
  const listsLink = (
    <p className="text-body text-muted-foreground">
      {t("priceListsHint")} <Link to="/admin/price-lists" className="text-link hover:underline">{t("priceListsLink")}</Link>.
    </p>
  );
  // Steps, endings and the preview's converted prices are amounts of the market's currency;
  // the preview's product prices are the shop currency's.
  const increment = own ? marketCurrencyIncrementMinor(values.currencyCode) : backupIncrement;
  const places = getDecimalPlaces(values.currencyCode);
  const unit = 10 ** places;
  const major = (minor: number) => money(values.currencyCode, minor);
  const shopUnit = 10 ** getDecimalPlaces(values.shopCurrencyCode);
  const steps = roundingChoices(values.currencyCode, increment);
  const endings = endingChoices(values.priceRoundingMinor, increment);
  const preview = adjustedPricePreview(values, increment, PREVIEW_UNITS.map((units) => units * shopUnit));
  const modes = own ? (["fx"] as const) : (["fixed", "fx"] as const);
  return (
    <SettingsCard title={t("pricingTitle")}>
      <RadioGroup
        aria-label={t("pricingTitle")}
        value={values.priceMode}
        disabled={!canEdit}
        onValueChange={(mode) => setValues((draft) => ({ ...draft, priceMode: mode === "fx" ? "fx" : "fixed" }))}
      >
        {modes.map((mode) => (
          <label key={mode} className="flex min-h-11 items-start gap-2 py-2 text-body">
            <span className="flex h-lh items-center"><RadioGroupItem value={mode} /></span>
            <span>
              <span className="block font-medium">{t(mode === "fx" ? (own ? "convertedPrices" : "pricingAdjusted") : "pricingFixed")}</span>
              <span className="block text-muted-foreground">
                {mode === "fx" && own ? t("convertedPricesHelp", { currency: values.currencyCode }) : t(mode === "fx" ? "pricingAdjustedHelp" : "pricingFixedHelp")}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {values.priceMode === "fx" || own ? (
        <>
          {own ? null : <p className="text-body text-muted-foreground">{t("sameCurrencyRate", { currency: values.currencyCode })}</p>}
          <SettingsField id="market-adjustment" label={t("adjustment")} help={t("adjustmentHelp")} error={adjustmentError}>
            <NumberInput
              id="market-adjustment"
              className="max-w-32"
              disabled={!canEdit}
              value={values.priceAdjustmentPercent}
              onValueChange={(priceAdjustmentPercent) => setValues((draft) => ({ ...draft, priceAdjustmentPercent }))}
            />
          </SettingsField>
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField id="market-rounding" label={t("rounding")} help={t("roundingHelp")}>
              <SearchableSelect
                id="market-rounding"
                value={values.priceRoundingMinor === null ? "" : String(values.priceRoundingMinor)}
                disabled={!canEdit}
                triggerClassName="block w-full"
                options={[
                  { value: "", label: t("roundingIncrement") },
                  ...steps.map((step) => ({ value: String(step), label: major(step) })),
                ]}
                onValueChange={(value) => setValues((draft) => {
                  const priceRoundingMinor = value ? Number(value) : null;
                  // An ending must fit inside the new step; otherwise it goes.
                  const keep = draft.priceEndingMinor !== null && endingChoices(priceRoundingMinor, increment).includes(draft.priceEndingMinor);
                  return { ...draft, priceRoundingMinor, priceEndingMinor: keep ? draft.priceEndingMinor : null };
                })}
              />
            </SettingsField>
            <SettingsField id="market-ending" label={t("ending")} help={t("endingHelp")}>
              <SearchableSelect
                id="market-ending"
                value={values.priceEndingMinor === null ? "" : String(values.priceEndingMinor)}
                disabled={!canEdit || endings.length === 0}
                triggerClassName="block w-full"
                options={[
                  { value: "", label: t("endingNone") },
                  ...endings.map((ending) => ({ value: String(ending), label: formatNumber(ending / unit, { minimumFractionDigits: places }) })),
                ]}
                onValueChange={(value) => setValues((draft) => ({ ...draft, priceEndingMinor: value ? Number(value) : null }))}
              />
            </SettingsField>
          </div>
          {preview.length > 0 ? (
            <div className="space-y-1 text-body">
              <p className="font-medium">{t("previewTitle")}</p>
              <ul className="text-muted-foreground">
                {preview.map((row) => <li key={row.base}>{t("previewRow", { base: money(values.shopCurrencyCode, row.base), adjusted: major(row.adjusted) })}</li>)}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {listsLink}
    </SettingsCard>
  );
}

/** Delete, apart from the save bar (Shopify's market page). A market with orders is set to draft instead. */
function DeleteMarket({ id, name, revision, hasOrders }: { id: string; name: string; revision: number; hasOrders: boolean }) {
  const t = useMessages(settingsMarketsMessages);
  const common = useMessages(settingsMessages);
  const navigate = useNavigate();
  const remove = useDeleteMarket();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2">
      <Button type="button" variant="destructive" disabled={hasOrders} aria-describedby={hasOrders ? "market-delete-note" : undefined} onClick={() => setConfirming(true)}>
        {t("delete")}
      </Button>
      {hasOrders ? <p id="market-delete-note" className="text-body text-muted-foreground">{t("hasOrders")}</p> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("deleteTitle", { name })}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={common("cancel")}
        loadingLabel={t("deleting")}
        isLoading={remove.isPending}
        onConfirm={() =>
          remove.mutate({ id, revision }, {
            onSuccess: async () => {
              toast.success(t("deleted"));
              setConfirming(false);
              await navigate({ to: "/admin/settings/markets" });
            },
            onError: (error) => void toast.error(getServerFnError(error, t("deleteFailed"))),
          })}
      />
    </div>
  );
}
