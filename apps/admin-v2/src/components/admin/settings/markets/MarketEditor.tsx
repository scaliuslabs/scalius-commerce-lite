// One market (docs/MARKETS-DESIGN.md D4), Shopify's market page: its name
// and status, Countries, Currency (the shop currency, locked until markets
// get their own), Web presence (a subfolder and its language) and the price
// increment. One save bar saves the page under the revision it loaded; the
// delete action sits apart at the bottom.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  cashOnDeliveryIncrementMinor,
  isWholeUnitIncrement,
  priceIncrementChoices,
  resolvePriceIncrementMinor,
} from "@scalius/shared/currency-policy";
import { toast } from "~/lib/toast";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { getLocale, useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { settingsMarketsMessages } from "~/i18n/settings-markets";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import { isAdminApiNotFoundError } from "~/lib/admin-api-error";
import { marketWriteInvalidations, marketsQueryOptions, saveMarket, useDeleteMarket } from "~/lib/api-query-options/markets";
import { SettingsCard, SettingsCardLoading, SettingsField, SettingsPage } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { MarketCountryPicker } from "./MarketCountryPicker";
import {
  EMPTY_MARKET_FORM,
  MARKET_LANGUAGES,
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

function displayName(code: string, type: "language" | "currency"): string {
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
    fields: { name: "market-name", handle: "market-handle", countries: "market-countries", presence: "market-suffix" },
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
  const savedStatus = saved.data.status;
  return (
    <SettingsPage
      page="markets"
      back={back}
      title={saved.data.name}
      readOnly={!canEdit}
      actions={
        <span className="flex items-center gap-2">
          {saved.data.isBackup ? <Badge variant="info">{t("backup")}</Badge> : null}
          <StatusBadge status={savedStatus}>{t(savedStatus)}</StatusBadge>
        </span>
      }
    >
      <SettingsCard title={t("detailsTitle")}>
        <SettingsField id="market-name" label={t("name")} help={t("nameHelp")} error={problems.name ? t(problems.name) : null}>
          <Input id="market-name" value={values.name} maxLength={80} disabled={!canEdit} onChange={(event) => setValue("name", event.target.value)} />
        </SettingsField>
        <SettingsField id="market-handle" label={t("handle")} help={t("handleHelp")} error={problems.handle ? t(problems.handle) : null}>
          <Input id="market-handle" value={values.handle} maxLength={60} disabled={!canEdit} onChange={(event) => setValue("handle", event.target.value)} />
        </SettingsField>
        {values.isBackup ? (
          <p className="text-body text-muted-foreground">{t("backupAlwaysActive")}</p>
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

      <SettingsCard title={t("countries")} description={t(values.isBackup ? "backupCountriesHelp" : "countriesHelp")}>
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

      <SettingsCard title={t("currencyTitle")}>
        <p className="text-body">{displayName(values.currencyCode, "currency")} ({values.currencyCode})</p>
        <p className="text-body text-muted-foreground">
          {t("currencyLocked")}{" "}
          <Link to="/admin/settings/store" hash="storeDefaults" className="text-foreground underline">{t("storeDetails")}</Link>
        </p>
      </SettingsCard>

      <WebPresenceCard values={values} canEdit={canEdit} suffixError={problems.suffix ? t(problems.suffix) : null} setValues={setValues} />

      <PriceIncrementCard values={values} canEdit={canEdit} onChange={(priceIncrementMinor) => setValue("priceIncrementMinor", priceIncrementMinor)} />

      {!saved.data.isBackup && canEdit ? <DeleteMarket id={marketId} name={saved.data.name} revision={saved.data.revision} hasOrders={saved.data.hasOrders} /> : null}
    </SettingsPage>
  );
}

function WebPresenceCard({ values, canEdit, suffixError, setValues }: {
  values: MarketForm;
  canEdit: boolean;
  suffixError: string | null;
  setValues: (update: (draft: MarketForm) => MarketForm) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const languages = MARKET_LANGUAGES.includes(values.locale as (typeof MARKET_LANGUAGES)[number])
    ? MARKET_LANGUAGES
    : [...MARKET_LANGUAGES, values.locale];
  const languageField = (
    <SettingsField id="market-language" label={t("language")} help={t("languageHelp")}>
      <SearchableSelect
        id="market-language"
        value={values.locale}
        disabled={!canEdit}
        triggerClassName="w-full sm:w-64"
        options={languages.map((code) => ({ value: code, label: displayName(code, "language"), keywords: [code] }))}
        onValueChange={(locale) => setValues((draft) => ({ ...draft, locale }))}
      />
    </SettingsField>
  );
  const path = presencePath(values);
  if (values.isBackup) {
    return (
      <SettingsCard title={t("presenceTitle")} description={t("rootHelp")}>
        {values.hasRootPresence ? languageField : null}
        <p className="text-body">{t("address")}: <code>/</code></p>
      </SettingsCard>
    );
  }
  return (
    <SettingsCard title={t("presenceTitle")}>
      <label className="flex min-h-11 items-center justify-between gap-4 text-body">
        <span>
          <span className="block font-medium">{t("useSubfolder")}</span>
          <span className="block text-muted-foreground">{t(values.subfolder ? "subfolderHelp" : "noSubfolderHelp")}</span>
        </span>
        <Switch checked={values.subfolder} disabled={!canEdit} onCheckedChange={(on) => setValues((draft) => withSubfolder(draft, on))} />
      </label>
      {values.subfolder ? (
        <>
          {languageField}
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
 * The price increment (MARKETS-DESIGN D1): whole units or minor units, the
 * backup market's own and used by every other market. Only a currency with
 * decimals has the choice. Cash on delivery in BDT collects whole taka
 * whatever is chosen, so a taka store that prices in paisa is told so.
 */
function PriceIncrementCard({ values, canEdit, onChange }: {
  values: MarketForm;
  canEdit: boolean;
  onChange: (priceIncrementMinor: number) => void;
}) {
  const t = useMessages(settingsMarketsMessages);
  const code = values.currencyCode;
  const choices = priceIncrementChoices(code);
  const whole = isWholeUnitIncrement(code, resolvePriceIncrementMinor(code, values.priceIncrementMinor));
  if (!values.isBackup) {
    return <SettingsCard title={t("incrementTitle")} description={t(whole ? "inheritedWhole" : "inheritedMinor")} />;
  }
  if (choices.length < 2) {
    return <SettingsCard title={t("incrementTitle")} description={t("noIncrementChoice", { currency: code })} />;
  }
  const takaCash = cashOnDeliveryIncrementMinor(code) > 1 && !whole;
  return (
    <SettingsCard title={t("incrementTitle")}>
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
