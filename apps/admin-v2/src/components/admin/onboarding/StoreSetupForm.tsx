// The new-store setup step after the first admin (Shopify's "Tell us about
// your store"): store name, country/region, currency (the country's, CLDR),
// store language, time zone (the browser's) and units (the country's). One
// request writes them all; the API refuses a store that is no longer new.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { postApiV1AdminSettingsStoreSetup } from "@scalius/api-client/sdk";
import { SUPPORTED_CURRENCY_CODES, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { getCountries } from "@scalius/shared/customer-utils";
import { SYSTEM_WEIGHT_UNITS, type UnitSystem, type WeightUnit } from "@scalius/shared/store-defaults";
import { defaultCurrencyForCountry, defaultUnitSystemForCountry } from "@scalius/shared/store-country-defaults";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { LOCALES, getLocale, useMessages } from "~/i18n";
import { storeSetupMessages } from "~/i18n/store-setup";
import { apiData } from "~/lib/api";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { countryName } from "~/lib/country-name";
import { queryKeys } from "~/lib/query-keys";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import { browserTimeZone, timeZoneOptions } from "~/lib/time-zone-options";
import type { StoreSetupStatus } from "~/lib/api-query-options/store-defaults";

/** A labelled field with its help or error line (the sign-in screens' shape, without their icons). */
function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error || hint ? (
        <p id={`${id}-message`} className={error ? "text-body text-destructive" : "text-body text-muted-foreground"}>
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}

interface Draft {
  storeName: string;
  countryCode: string;
  currencyCode: string;
  locale: string;
  timeZone: string;
  unitSystem: UnitSystem;
  weightUnit: WeightUnit;
}

function currencyLabel(code: string): string {
  try {
    const name = new Intl.DisplayNames([getLocale() === "bn" ? "bn" : "en"], { type: "currency" }).of(code) ?? code;
    return `${name} (${code})`;
  } catch {
    return code;
  }
}

/** The form's first values: what the store has, with the browser's zone. */
function initialDraft(status: StoreSetupStatus): Draft {
  const { current } = status;
  return {
    storeName: current.storeName,
    countryCode: current.countryCode,
    currencyCode: current.currencyCode,
    locale: current.locale,
    timeZone: browserTimeZone() ?? current.timeZone,
    unitSystem: defaultUnitSystemForCountry(current.countryCode),
    weightUnit: SYSTEM_WEIGHT_UNITS[defaultUnitSystemForCountry(current.countryCode)][0]!,
  };
}

export function StoreSetupForm({ status }: { status: StoreSetupStatus }) {
  const t = useMessages(storeSetupMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(status));
  const [nameError, setNameError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const countries = useMemo(
    () => getCountries()
      .map((code) => ({ value: code, label: countryName(code), keywords: [code] }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    [],
  );
  const currencies = useMemo(
    () => SUPPORTED_CURRENCY_CODES.map((code) => ({ value: code, label: currencyLabel(code), keywords: [code] })),
    [],
  );
  const zones = useMemo(() => timeZoneOptions(draft.timeZone, getLocale()), [draft.timeZone]);
  const languages = useMemo(() => {
    const listed: string[] = LOCALES.map((option) => option.value);
    return (listed.includes(draft.locale) ? listed : [...listed, draft.locale]).map((code) => ({
      value: code,
      label: LOCALES.find((option) => option.value === code)?.label ?? code,
    }));
  }, [draft.locale]);

  function chooseCountry(countryCode: string) {
    const unitSystem = defaultUnitSystemForCountry(countryCode);
    setDraft((current) => ({
      ...current,
      countryCode,
      // A locked currency stays; otherwise the country's (CLDR).
      currencyCode: status.currencyLocked ? current.currencyCode : defaultCurrencyForCountry(countryCode),
      unitSystem,
      weightUnit: SYSTEM_WEIGHT_UNITS[unitSystem][0]!,
    }));
  }

  async function finish() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    await navigate({ to: "/admin" });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!draft.storeName.trim()) {
      setNameError(true);
      formRef.current?.querySelector<HTMLInputElement>("#setup-store-name")?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const saved = await apiData(postApiV1AdminSettingsStoreSetup({
        body: {
          storeName: draft.storeName.trim(),
          countryCode: draft.countryCode,
          currencyCode: draft.currencyCode,
          locale: draft.locale,
          timeZone: draft.timeZone,
          unitSystem: draft.unitSystem,
          weightUnit: draft.weightUnit,
        },
      }));
      setStoreTimeZone(saved.timeZone);
      await finish();
    } catch (error) {
      setFailure(error instanceof AdminApiResponseError && error.status === 409 ? t("alreadySetUp") : t("saveFailed"));
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading-lg font-semibold">{t("title")}</h1>
        <p className="text-body text-muted-foreground">{t("description")}</p>
      </header>
      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      <Field id="setup-store-name" label={t("storeName")} error={nameError ? t("storeNameRequired") : null}>
        <Input
          id="setup-store-name"
          value={draft.storeName}
          maxLength={120}
          autoComplete="organization"
          aria-invalid={nameError || undefined}
          autoFocus
          onChange={(event) => {
            const storeName = event.target.value;
            setDraft((current) => ({ ...current, storeName }));
            if (nameError && storeName.trim()) setNameError(false);
          }}
        />
      </Field>
      <Field id="setup-country" label={t("country")} hint={t("countryHelp")}>
        <SearchableSelect
          id="setup-country"
          value={draft.countryCode}
          options={countries}
          searchPlaceholder={t("countrySearch")}
          emptyMessage={t("countryNone")}
          triggerClassName="w-full"
          onValueChange={chooseCountry}
        />
      </Field>
      <Field
        id="setup-currency"
        label={t("currency")}
        hint={status.currencyLocked ? t("currencyLocked", { code: draft.currencyCode }) : t("currencyHelp")}
      >
        <SearchableSelect
          id="setup-currency"
          value={draft.currencyCode}
          options={currencies}
          disabled={status.currencyLocked}
          searchPlaceholder={t("currencySearch")}
          emptyMessage={t("currencyNone")}
          triggerClassName="w-full"
          onValueChange={(code) => {
            const currencyCode = normalizeSupportedCurrencyCode(code);
            if (currencyCode) setDraft((current) => ({ ...current, currencyCode }));
          }}
        />
      </Field>
      <Field id="setup-language" label={t("language")}>
        <SearchableSelect
          id="setup-language"
          value={draft.locale}
          options={languages}
          triggerClassName="w-full"
          onValueChange={(locale) => setDraft((current) => ({ ...current, locale }))}
        />
      </Field>
      <Field id="setup-time-zone" label={t("timeZone")} hint={t("timeZoneHelp")}>
        <SearchableSelect
          id="setup-time-zone"
          value={draft.timeZone}
          options={zones}
          searchPlaceholder={t("timeZoneSearch")}
          emptyMessage={t("timeZoneNone")}
          triggerClassName="w-full"
          onValueChange={(timeZone) => setDraft((current) => ({ ...current, timeZone }))}
        />
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-body font-medium">{t("unitSystem")}</legend>
        <RadioGroup
          value={draft.unitSystem}
          onValueChange={(value) => {
            const unitSystem = value as UnitSystem;
            setDraft((current) => ({ ...current, unitSystem, weightUnit: SYSTEM_WEIGHT_UNITS[unitSystem][0]! }));
          }}
        >
          {(["metric", "imperial"] as const).map((system) => (
            <label key={system} className="flex min-h-11 items-center gap-2 text-body md:min-h-9">
              <RadioGroupItem value={system} />
              {t(system)}
            </label>
          ))}
        </RadioGroup>
      </fieldset>
      <Field id="setup-weight-unit" label={t("weightUnit")}>
        <SearchableSelect
          id="setup-weight-unit"
          value={draft.weightUnit}
          options={SYSTEM_WEIGHT_UNITS[draft.unitSystem].map((unit) => ({ value: unit, label: t(`unit_${unit}`) }))}
          triggerClassName="w-full"
          onValueChange={(unit) => setDraft((current) => ({ ...current, weightUnit: unit as WeightUnit }))}
        />
      </Field>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void finish()}>
          {t("skip")}
        </Button>
        <Button type="submit" loading={busy}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
