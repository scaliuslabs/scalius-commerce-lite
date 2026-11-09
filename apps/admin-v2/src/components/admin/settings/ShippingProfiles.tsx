// Settings → Shipping → Shipping profiles (rules/decisions/2026-10-24-shipping-profiles.md).
// Each profile shows its products and what they pay behind each delivery
// option: the zone's charge (General, which has no charges of its own),
// General's (a profile without its own), its own charges with weight and
// order-value bands, or free on every option.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useWholeUnitPrices } from "~/components/admin/shared/MoneyInput";
import { WeightInput, useWeightUnit } from "~/components/admin/product-form/variants/WeightInput";
import { formatWeight } from "~/components/admin/product-form/variants/weight-format";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiClient, apiData } from "~/lib/api";
import { parseAmountInput } from "~/lib/money-input";
import {
  PROFILES_URL,
  deliveryZonesQuery,
  shippingProfilesQuery,
  type DeliveryZones,
  type ShippingProfile,
  type ShippingProfileRate,
} from "~/lib/api-query-options/settings-screens";
import { seededName, savedSeededName } from "~/lib/seeded-names";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { shippingMessages } from "~/i18n/settings-shipping";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";
import { settingsSheet } from "./SettingsSheet";
import { sameFormValue } from "~/lib/form-values";

type Messages = ReturnType<typeof useMessages<keyof typeof shippingMessages.en>>;

const MAX_AMOUNT = 100_000;
const json = { "Content-Type": "application/json" };
const send = (method: "post" | "put" | "delete", url: string, body?: unknown) =>
  apiData(apiClient[method]({ url, headers: json, ...(body === undefined ? {} : { body }) }));

/** A delivery option a profile can price: a zone's rate or a pickup point. */
interface DeliveryOption {
  id: string;
  label: string;
  fee: number;
  freeOver: number | null;
  calculated: boolean;
}

function deliveryOptions(zones: DeliveryZones, t: Messages): DeliveryOption[] {
  const option = (zoneName: string, rate: DeliveryZones["zones"][number]["rates"][number]): DeliveryOption => ({
    id: rate.id,
    label: t("profileOptionZone", { zone: zoneName, option: rate.name }),
    fee: rate.fee,
    freeOver: rate.freeOver,
    calculated: rate.rateSource !== "flat",
  });
  return [
    ...zones.zones.flatMap((zone) => zone.rates.map((rate) => option(zone.name, rate))),
    ...zones.pickup.rates.map((rate) => option(t("pickupTitle"), rate)),
  ];
}

/** An option's own charge, General's price: "৳60 · free when General's products total ৳3,000". */
function useZoneChargeWords() {
  const t = useMessages(shippingMessages);
  const { fmt } = useCurrency();
  return (option: DeliveryOption) => [
    option.calculated ? t("calculatedCharge") : option.fee === 0 ? t("free") : fmt(option.fee),
    option.freeOver === null || option.calculated ? null : t("profileZoneFreeOver", { amount: fmt(option.freeOver) }),
  ].filter(Boolean).join(" · ");
}

function useRefreshProfiles() {
  const queryClient = useQueryClient();
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.shippingProfiles() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
  ]);
}

/** One charge in plain words: "৳120 for 2 kg to 5 kg, orders ৳1,000–৳5,000 · free over ৳1,500 of these items". */
function useRateWords() {
  const t = useMessages(shippingMessages);
  const { fmt } = useCurrency();
  const unit = useWeightUnit();
  return (rate: ShippingProfileRate) => {
    const weight = (grams: number) => formatWeight(grams, unit);
    const band = (from: string | null, to: string | null) => from && to
      ? t("profileRateWeight", { from, to })
      : to ? t("profileRateUpTo", { to }) : from ? t("profileRateFrom", { from }) : null;
    const conditions = [
      band(rate.minWeightGrams === null ? null : weight(rate.minWeightGrams), rate.maxWeightGrams === null ? null : weight(rate.maxWeightGrams)),
      (() => {
        const range = band(rate.minSubtotal === null ? null : fmt(rate.minSubtotal), rate.maxSubtotal === null ? null : fmt(rate.maxSubtotal));
        return range ? t("profileRateOrders", { range }) : null;
      })(),
    ].filter((part): part is string => Boolean(part));
    const fee = rate.fee === 0 ? t("free") : fmt(rate.fee);
    return [
      conditions.length ? t("profileRateFor", { fee, condition: conditions.join(", ") }) : t("profileRateAny", { fee }),
      rate.freeOver === null ? null : t("profileRateFreeOver", { amount: fmt(rate.freeOver) }),
    ].filter(Boolean).join(" · ");
  };
}

// ── The editor ─────────────────────────────────────────────────────────

interface RateDraft {
  key: string;
  methodId: string;
  fee: string;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  minSubtotal: string;
  maxSubtotal: string;
  freeOver: string;
}

interface ProfileDraft {
  name: string;
  freeDelivery: boolean;
  defaultWeightGrams: number | null;
  rates: RateDraft[];
}

const text = (value: number | null) => (value === null ? "" : String(value));
let draftKey = 0;
const newKey = () => `rate-${(draftKey += 1)}`;

function toDraft(profile: ShippingProfile | null): ProfileDraft {
  return {
    name: profile ? seededName(profile) : "",
    freeDelivery: profile?.freeDelivery ?? false,
    defaultWeightGrams: profile?.defaultWeightGrams ?? null,
    rates: (profile?.rates ?? []).map((rate) => ({
      key: rate.id ?? newKey(),
      methodId: rate.methodId,
      fee: String(rate.fee),
      minWeightGrams: rate.minWeightGrams,
      maxWeightGrams: rate.maxWeightGrams,
      minSubtotal: text(rate.minSubtotal),
      maxSubtotal: text(rate.maxSubtotal),
      freeOver: text(rate.freeOver),
    })),
  };
}

type RateError = "feeInvalid" | "feeTooHigh" | "wholeTaka" | "profileBandInverted";

function amountError(raw: string, wholeTaka: boolean, required: boolean): RateError | null {
  if (!raw.trim()) return required ? "feeInvalid" : null;
  const amount = parseAmountInput(raw);
  if (amount === null) return "feeInvalid";
  if (amount > MAX_AMOUNT) return "feeTooHigh";
  return wholeTaka && !Number.isInteger(amount) ? "wholeTaka" : null;
}

export function profileRateErrors(rate: RateDraft, wholeTaka = false): Partial<Record<"fee" | "maxWeightGrams" | "minSubtotal" | "maxSubtotal" | "freeOver", RateError>> {
  const errors: Partial<Record<"fee" | "maxWeightGrams" | "minSubtotal" | "maxSubtotal" | "freeOver", RateError>> = {};
  const fee = amountError(rate.fee, wholeTaka, true);
  if (fee) errors.fee = fee;
  for (const field of ["minSubtotal", "maxSubtotal", "freeOver"] as const) {
    const error = amountError(rate[field], wholeTaka, false);
    if (error) errors[field] = error;
  }
  const weightsOk = [rate.minWeightGrams, rate.maxWeightGrams].every((grams) => grams === null || Number.isFinite(grams));
  if (!weightsOk) errors.maxWeightGrams = "feeInvalid";
  else if (rate.minWeightGrams !== null && rate.maxWeightGrams !== null && rate.minWeightGrams > rate.maxWeightGrams) errors.maxWeightGrams = "profileBandInverted";
  const minValue = parseAmountInput(rate.minSubtotal);
  const maxValue = parseAmountInput(rate.maxSubtotal);
  if (!errors.maxSubtotal && minValue !== null && maxValue !== null && minValue > maxValue) errors.maxSubtotal = "profileBandInverted";
  return errors;
}

/** The API body of a profile: whole grams, decimal major units. */
export function profileBody(draft: ProfileDraft) {
  const amount = (raw: string) => (raw.trim() ? parseAmountInput(raw) : null);
  const grams = (value: number | null) => (value === null ? null : Math.round(value));
  return {
    name: draft.name.trim(),
    defaultWeightGrams: grams(draft.defaultWeightGrams),
    ...(draft.freeDelivery ? {} : {
      rates: draft.rates.map((rate) => ({
        methodId: rate.methodId,
        fee: amount(rate.fee) ?? 0,
        minWeightGrams: grams(rate.minWeightGrams),
        maxWeightGrams: grams(rate.maxWeightGrams),
        minSubtotal: amount(rate.minSubtotal),
        maxSubtotal: amount(rate.maxSubtotal),
        freeOver: amount(rate.freeOver),
      })),
    }),
  };
}

function ProfileForm({ profile, options, storeWeightGrams }: {
  profile: ShippingProfile | null;
  options: DeliveryOption[];
  /** General's default weight: an unweighed product of another profile weighs it. */
  storeWeightGrams: number | null;
}) {
  const t = useMessages(shippingMessages);
  const common = useMessages(settingsMessages);
  const { symbol } = useCurrency();
  const zoneCharge = useZoneChargeWords();
  const wholeTaka = useWholeUnitPrices();
  const refresh = useRefreshProfiles();
  const [saved] = useState(() => toDraft(profile));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDefault = profile?.isDefault === true;
  const save = useMutation({
    mutationFn: () => profile
      // The seeded name shown in this language, untouched, stays stored as it was.
      ? send("put", `${PROFILES_URL}/${encodeURIComponent(profile.id)}`, { ...profileBody(draft), name: savedSeededName(profile, draft.name), expectedRevision: profile.revision })
      : send("post", PROFILES_URL, { ...profileBody(draft), freeDelivery: draft.freeDelivery }),
    onSuccess: refresh,
    onError: (error) => {
      if (error instanceof AdminApiResponseError && error.status === 409) void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => send("delete", `${PROFILES_URL}/${encodeURIComponent(profile!.id)}`),
    onSuccess: async () => {
      toast.success(t("profileDeleted"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });
  // Unweighed products weigh nothing in a weight charge when no default weight applies (QA D12).
  const weighs = draft.rates.some((rate) => rate.minWeightGrams !== null || rate.maxWeightGrams !== null);
  const unweighed = profile?.unweighedProductCount ?? 0;
  const unweighedWarning = weighs && unweighed > 0 && draft.defaultWeightGrams === null && storeWeightGrams === null
    ? t("profileUnweighedWarning", { count: unweighed })
    : null;
  const update = (key: string, patch: Partial<RateDraft>) =>
    setDraft((current) => ({ ...current, rates: current.rates.map((rate) => (rate.key === key ? { ...rate, ...patch } : rate)) }));
  useSaveBar({
    fields: (path) => {
      const [field, index, rateField] = path.split(".");
      if (field === "name") return "profile-name";
      if (field === "rates" && index !== undefined) return `profile-rate-${draft.rates[Number(index)]?.key}-${rateField ?? "fee"}`;
      return undefined;
    },
    dirty: !sameFormValue(draft, saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || draft.rates.some((rate) => Object.keys(profileRateErrors(rate, wholeTaka)).length > 0),
    save: () => save.mutateAsync(),
    discard: () => setDraft(saved),
  });
  const amountField = (rate: RateDraft, field: "fee" | "minSubtotal" | "maxSubtotal" | "freeOver", label: string) => {
    const id = `profile-rate-${rate.key}-${field}`;
    const error = profileRateErrors(rate, wholeTaka)[field];
    return (
      <SettingsField id={id} label={label} optional={field !== "fee"} error={error ? t(error, { max: formatNumber(MAX_AMOUNT) }) : null}>
        <Input id={id} prefix={symbol} inputMode={wholeTaka ? "numeric" : "decimal"} autoComplete="off" value={rate[field]} onChange={(event) => update(rate.key, { [field]: event.target.value })} />
      </SettingsField>
    );
  };
  const weightField = (rate: RateDraft, field: "minWeightGrams" | "maxWeightGrams", label: string) => {
    const id = `profile-rate-${rate.key}-${field}`;
    const error = field === "maxWeightGrams" ? profileRateErrors(rate, wholeTaka).maxWeightGrams : undefined;
    return (
      <SettingsField id={id} label={label} optional error={error ? t(error) : null}>
        <WeightInput id={id} grams={rate[field]} onGramsChange={(grams) => update(rate.key, { [field]: grams })} />
      </SettingsField>
    );
  };
  return (
    <>
      <SettingsField id="profile-name" label={t("profileName")} error={draft.name.trim() ? null : t("profileNameRequired")}>
        <Input id="profile-name" value={draft.name} maxLength={80} placeholder={t("profileNamePlaceholder")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </SettingsField>
      {profile ? (
        draft.freeDelivery ? <p className="text-body text-muted-foreground">{t("profileShipsFreeFixed")}</p> : null
      ) : (
        <ChoiceField
          id="profile-free"
          label={t("profileShipsFree")}
          help={t("profileShipsFreeHelp")}
          control={<Checkbox id="profile-free" checked={draft.freeDelivery} onCheckedChange={(checked) => setDraft({ ...draft, freeDelivery: checked === true, rates: [] })} />}
        />
      )}
      <SettingsField
        id="profile-weight"
        label={t("profileDefaultWeight")}
        optional
        help={t(isDefault ? "profileStoreWeightHelp" : "profileDefaultWeightHelp")}
      >
        <WeightInput id="profile-weight" className="sm:max-w-48" grams={draft.defaultWeightGrams} onGramsChange={(grams) => setDraft({ ...draft, defaultWeightGrams: grams })} />
      </SettingsField>
      {isDefault ? (
        // General's price is each option's own charge, set in the zone: one place states it (QA D4).
        <section className="space-y-3 border-t border-border pt-4">
          <div className="space-y-1">
            <h3 className="text-heading-sm">{t("profileRatesTitle")}</h3>
            <p className="text-body text-muted-foreground">{t("profileGeneralRatesHelp")}</p>
          </div>
          <ul className="space-y-1 text-body">
            {options.map((option) => (
              <li key={option.id}>{t("profileOptionCharge", { option: option.label, charge: zoneCharge(option) })}</li>
            ))}
          </ul>
        </section>
      ) : draft.freeDelivery ? null : (
        <section className="space-y-4 border-t border-border pt-4">
          <div className="space-y-1">
            <h3 className="text-heading-sm">{t("profileRatesTitle")}</h3>
            <p className="text-body text-muted-foreground">{t("profileRatesHelp")}</p>
          </div>
          {unweighedWarning ? (
            <Alert variant="warning" role="note">
              <AlertDescription>{unweighedWarning}</AlertDescription>
            </Alert>
          ) : null}
          {options.map((option) => {
            const rates = draft.rates.filter((rate) => rate.methodId === option.id);
            return (
              <fieldset key={option.id} className="space-y-3 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0">
                <legend className="text-body font-medium">{option.label}</legend>
                {rates.length === 0 ? (
                  // General's charge here has no weight limit: a cart of any weight can use the option (QA D6).
                  <p className="text-body text-muted-foreground">{t("profileOptionSame", { charge: zoneCharge(option) })}</p>
                ) : null}
                {rates.map((rate) => (
                  <div key={rate.key} className="space-y-3 rounded-lg border border-border p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      {amountField(rate, "fee", t("fee"))}
                      {weightField(rate, "minWeightGrams", t("profileWeightFrom"))}
                      {weightField(rate, "maxWeightGrams", t("profileWeightTo"))}
                      {amountField(rate, "minSubtotal", t("profileValueFrom"))}
                      {amountField(rate, "maxSubtotal", t("profileValueTo"))}
                      {amountField(rate, "freeOver", t("profileFreeOver"))}
                    </div>
                    <Button type="button" variant="ghost" onClick={() => setDraft((current) => ({ ...current, rates: current.rates.filter((entry) => entry.key !== rate.key) }))}>
                      {t("profileRemoveRate")}
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft((current) => ({
                    ...current,
                    rates: [...current.rates, { key: newKey(), methodId: option.id, fee: "", minWeightGrams: null, maxWeightGrams: null, minSubtotal: "", maxSubtotal: "", freeOver: "" }],
                  }))}
                >
                  <Plus aria-hidden="true" />
                  {t("profileAddRate")}
                </Button>
              </fieldset>
            );
          })}
        </section>
      )}
      {profile && !isDefault ? (
        <>
          <Button type="button" variant="ghost" className="self-start" onClick={() => setConfirmDelete(true)}>
            {t("deleteProfile")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: seededName(profile) })}
            description={t("deleteProfileConfirm")}
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

// ── The card ───────────────────────────────────────────────────────────

export function ShippingProfilesCard() {
  const t = useMessages(shippingMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT);
  const canView = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const profiles = useQuery({ ...shippingProfilesQuery, enabled: canView });
  const zones = useQuery({ ...deliveryZonesQuery, enabled: canView });
  const words = useRateWords();
  const options = useMemo(() => (zones.data ? deliveryOptions(zones.data, t) : []), [zones.data, t]);
  if (!canView) return null;
  if (profiles.isError) return <SettingsLoadFailure title={t("loadProfiles")} onRetry={profiles.refetch} />;
  if (!profiles.data || !zones.data) return <SettingsCardLoading />;
  const list = profiles.data;
  const storeWeightGrams = list.find((profile) => profile.isDefault)?.defaultWeightGrams ?? null;
  const optionLabel = (methodId: string) => options.find((option) => option.id === methodId)?.label ?? "";
  const summary = (profile: ShippingProfile) => {
    const products = profile.isDefault ? t("profileDefaultProducts") : t("profileProducts", { count: profile.productCount });
    const live = profile.rates.filter((rate) => options.some((option) => option.id === rate.methodId));
    const charges = profile.freeDelivery
      ? t("profileFreeSummary")
      : live.length === 0
        ? t(profile.isDefault ? "profileZoneRates" : "profileSameAsDefault")
        : live.length <= 2
          // Each charge names its delivery option (QA D11).
          ? live.map((rate) => t("profileOptionCharge", { option: optionLabel(rate.methodId), charge: words(rate) })).join(" · ")
          : t("profileOwnRates", { count: new Set(live.map((rate) => rate.methodId)).size });
    return `${products} · ${charges}`;
  };
  return (
    <SettingsCard
      id="shippingProfiles"
      title={t("profilesTitle")}
      description={list.length > 1 ? t("profilesDescription") : t("profilesOne")}
      action={
        <SettingsDialog layout={settingsSheet} title={t("addProfile")} trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addProfile")}</Button>}>
          <ProfileForm profile={null} options={options} storeWeightGrams={storeWeightGrams} />
        </SettingsDialog>
      }
      rows={list.map((profile) => (
        <SettingsDialog layout={settingsSheet} key={profile.id} title={t("editProfile", { name: seededName(profile) })} trigger={
          <SettingsRow disabled={!canEdit} label={seededName(profile)} value={summary(profile)} />
        }>
          <ProfileForm profile={profile} options={options} storeWeightGrams={storeWeightGrams} />
        </SettingsDialog>
      ))}
    />
  );
}
