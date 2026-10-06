// One country's tax (MARKETS-DESIGN step 3c), Shopify's country page under
// "Taxes and duties": which service calculates it, its rates and the rates of
// its regions (a state, a postal-code prefix, or a Bangladesh city, thana or
// area), the regions themselves, and stopping tax there. The most specific
// region with rates of a product's group applies; a rate added to the larger
// area's rates is charged with them.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminTaxesRatesById,
  deleteApiV1AdminTaxesRegionsById,
  postApiV1AdminTaxesRates,
  postApiV1AdminTaxesRegions,
  putApiV1AdminTaxesRatesById,
  putApiV1AdminTaxesRegionsById,
} from "@scalius/api-client/sdk";
import { SYSTEM_TAX_PROVIDER_ID } from "@scalius/shared/plugins/providers/kinds";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { taxesMessages } from "~/i18n/settings-taxes";
import { isAdminApiNotFoundError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { addressRulesQueryOptions } from "~/lib/api-query-options/address-rules";
import { deliveryLocationLoader } from "~/lib/api-query-options/delivery";
import {
  taxConfigurationQueryOptions,
  taxRegionQueryOptions,
  type TaxConfigurationPayload,
  type TaxRateRecord,
  type TaxRegionRecord,
} from "~/lib/api-query-options/taxes";
import { countryName } from "~/lib/country-name";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "../settings/SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsPage, SettingsRow } from "../settings/SettingsPage";
import { useTaxServices } from "./TaxesSettings";
import {
  basisPointsToPercent,
  getRequiredTaxRateRoles,
  normalizePostalPrefix,
  percentToBasisPoints,
  taxRegionName,
} from "./tax-form";
import { NONE, SwitchRow, useCanManageTaxes, useGroupName, useRefreshTaxes, useSaveFailure, useWriteFailure } from "./tax-shared";

const BD = "BD";

function useRegionName() {
  const t = useMessages(taxesMessages);
  return (region: TaxRegionRecord) => taxRegionName(region, countryName, (prefix) => t("postalSummary", { prefix }));
}

// ── Service ─────────────────────────────────────────────────────────────

function ServiceCard({ region, storeProviderId }: { region: TaxRegionRecord; storeProviderId: string }) {
  const t = useMessages(taxesMessages);
  const canEdit = useCanManageTaxes();
  const services = useTaxServices();
  const refresh = useRefreshTaxes();
  const saveFailure = useSaveFailure();
  const saved = region.providerId ?? NONE;
  const [draft, setDraft] = useState(saved);
  const save = useMutation({
    mutationFn: () => apiData(putApiV1AdminTaxesRegionsById({
      path: { id: region.id },
      body: { expectedVersion: region.version, providerId: draft === NONE ? null : draft },
    })),
    onSuccess: refresh,
  });
  useSaveBar({
    fields: { service: "tax-region-service" },
    dirty: draft !== saved,
    saving: save.isPending,
    save: () => save.mutateAsync().catch(saveFailure),
    discard: () => setDraft(saved),
  });
  if (!services.hasApps && !region.providerId) return null;
  return (
    <SettingsCard title={t("service")}>
      <SettingsField id="tax-region-service" label={t("service")} help={t("serviceRegionHelp", { country: countryName(region.countryCode) })}>
        <SearchableSelect
          id="tax-region-service"
          aria-describedby="tax-region-service-note"
          value={draft}
          disabled={!canEdit}
          onValueChange={setDraft}
          options={[{ value: NONE, label: t("storeDefault", { name: services.name(storeProviderId) }) }, ...services.options]}
          ariaLabel={t("service")}
          triggerClassName="w-full"
        />
      </SettingsField>
    </SettingsCard>
  );
}

// ── Rates ───────────────────────────────────────────────────────────────

interface RateDraft {
  name: string;
  percent: string;
  taxClassId: string;
  taxRegionId: string;
  combinable: boolean;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

function RateForm({ rate, country, regions, config }: {
  rate: TaxRateRecord | null;
  country: TaxRegionRecord;
  regions: TaxRegionRecord[];
  config: TaxConfigurationPayload;
}) {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshTaxes();
  const failWrite = useWriteFailure();
  const saveFailure = useSaveFailure();
  const groupName = useGroupName();
  const regionName = useRegionName();
  const [saved] = useState<RateDraft>(() => ({
    name: rate?.name ?? "",
    percent: rate ? basisPointsToPercent(rate.rateBps) : "",
    taxClassId: rate?.taxClassId ?? config.settings.defaultTaxClassId ?? config.classes[0]?.id ?? "",
    taxRegionId: rate?.taxRegionId ?? country.id,
    combinable: rate?.combinable ?? false,
    priority: String(rate?.priority ?? 0),
    isCompound: rate?.isCompound ?? false,
    isActive: rate?.isActive ?? true,
  }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof RateDraft>(key: K, value: RateDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const rateBps = percentToBasisPoints(draft.percent);
  const priority = /^\d{1,4}$/.test(draft.priority) && Number(draft.priority) <= 1000 ? Number(draft.priority) : null;
  const roles = getRequiredTaxRateRoles(config, rate);
  const breaksCoverage = roles.length > 0 && (!draft.isActive || draft.taxClassId !== rate?.taxClassId);
  const onlyRateNote = roles.length === 2 ? t("onlyRateBoth") : roles[0] === "delivery" ? t("onlyRateDelivery") : t("onlyRateProducts");
  const inCountry = draft.taxRegionId === country.id;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        taxClassId: draft.taxClassId,
        taxRegionId: draft.taxRegionId,
        name: draft.name.trim(),
        rateBps: rateBps!,
        priority: priority!,
        isCompound: draft.isCompound,
        // The country has nothing larger to add to.
        combinable: inCountry ? false : draft.combinable,
        isActive: draft.isActive,
      };
      return rate
        ? apiData(putApiV1AdminTaxesRatesById({ path: { id: rate.id }, body: { ...body, expectedVersion: rate.version } }))
        : apiData(postApiV1AdminTaxesRates({ body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () =>
      apiData(deleteApiV1AdminTaxesRatesById({ path: { id: rate!.id }, query: { expectedVersion: rate!.version } })),
    onSuccess: async () => {
      toast.success(t("rateDeleted"));
      await refresh();
    },
    onError: (error) => failWrite(error),
    onSettled: () => setConfirmDelete(false),
  });
  useSaveBar({
    fields: { name: "tax-rate-name" },
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || rateBps === null || priority === null || !draft.taxClassId || breaksCoverage,
    save: () => save.mutateAsync().catch(saveFailure),
    discard: () => setDraft(saved),
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="tax-rate-name" label={t("rateName")}>
          <Input id="tax-rate-name" maxLength={120} value={draft.name} onChange={(event) => set("name", event.target.value)} />
        </SettingsField>
        <SettingsField
          id="tax-rate-percent"
          label={t("ratePercent")}
          error={draft.percent.trim() && rateBps === null ? t("percentInvalid") : undefined}
        >
          <Input
            id="tax-rate-percent"
            inputMode="decimal"
            value={draft.percent}
            placeholder="15"
            aria-describedby="tax-rate-percent-note"
            onChange={(event) => set("percent", event.target.value)}
          />
        </SettingsField>
      </div>
      <SettingsField id="tax-rate-group" label={t("rateGroup")}>
        <SearchableSelect
          id="tax-rate-group"
          value={draft.taxClassId}
          onValueChange={(value) => set("taxClassId", value)}
          options={config.classes.map((group) => ({ value: group.id, label: groupName(group) }))}
          placeholder={t("chooseGroup")}
          ariaLabel={t("rateGroup")}
          triggerClassName="w-full"
        />
      </SettingsField>
      <SettingsField id="tax-rate-region" label={t("appliesIn")}>
        <SearchableSelect
          id="tax-rate-region"
          value={draft.taxRegionId}
          onValueChange={(value) => set("taxRegionId", value)}
          options={[
            { value: country.id, label: t("wholeCountry", { country: countryName(country.countryCode) }) },
            ...regions.map((region) => ({ value: region.id, label: regionName(region) })),
          ]}
          ariaLabel={t("appliesIn")}
          triggerClassName="w-full"
        />
      </SettingsField>
      {inCountry ? null : (
        <SwitchRow label={t("combinable")} help={t("combinableHelp")} checked={draft.combinable} onCheckedChange={(on) => set("combinable", on)} />
      )}
      <SettingsField
        id="tax-rate-order"
        label={t("order")}
        help={t("orderHelp")}
        error={priority === null ? t("orderInvalid") : undefined}
      >
        <Input
          id="tax-rate-order"
          inputMode="numeric"
          className="sm:w-32"
          value={draft.priority}
          aria-describedby="tax-rate-order-note"
          onChange={(event) => set("priority", event.target.value)}
        />
      </SettingsField>
      <SwitchRow label={t("compound")} checked={draft.isCompound} onCheckedChange={(on) => set("isCompound", on)} />
      <SwitchRow label={t("active")} checked={draft.isActive} onCheckedChange={(on) => set("isActive", on)} />
      {roles.length > 0 ? (
        <p
          role={breaksCoverage ? "alert" : undefined}
          className={cn("text-body", breaksCoverage ? "text-destructive" : "text-muted-foreground")}
        >
          {onlyRateNote}
        </p>
      ) : null}
      {rate ? (
        <>
          <Button type="button" variant="ghost" disabled={roles.length > 0} onClick={() => setConfirmDelete(true)}>
            {t("deleteRate")}
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: rate.name })}
            description={t("deleteConfirm", { name: rate.name })}
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

// ── Regions of the country ──────────────────────────────────────────────

type RegionKind = "admin_area" | "postal_prefix" | "city" | "zone" | "area";

function RegionForm({ country, regions }: { country: TaxRegionRecord; regions: TaxRegionRecord[] }) {
  const t = useMessages(taxesMessages);
  const refresh = useRefreshTaxes();
  const saveFailure = useSaveFailure();
  const bd = country.countryCode === BD;
  const rules = useQuery({ ...addressRulesQueryOptions(country.countryCode), enabled: !bd });
  const areas = (rules.data?.adminAreas ?? []).filter((area) => !regions.some((region) => region.adminArea === area.code));
  const kinds: RegionKind[] = bd ? ["city", "zone", "area"] : areas.length > 0 ? ["admin_area", "postal_prefix"] : ["postal_prefix"];
  const [kind, setKind] = useState<RegionKind>(kinds[0]!);
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const prefix = kind === "postal_prefix" ? normalizePostalPrefix(value) : null;
  const ready = kind === "postal_prefix" ? prefix !== null : value !== "";
  const create = useMutation({
    mutationFn: () => apiData(postApiV1AdminTaxesRegions({
      body: {
        countryCode: country.countryCode,
        ...(kind === "admin_area" ? { adminArea: value } : kind === "postal_prefix" ? { postalPrefix: prefix } : { placeId: value }),
      },
    })),
    onSuccess: refresh,
  });
  useSaveBar({
    fields: { region: "tax-region-value" },
    dirty: value !== "",
    saving: create.isPending,
    invalid: !ready,
    save: () => create.mutateAsync().catch(saveFailure),
    discard: () => setValue(""),
  });
  const kindLabel = (each: RegionKind) => each === "admin_area" ? t("adminArea") : each === "postal_prefix" ? t("postalCodes") : t(each);
  return (
    <>
      {kinds.length > 1 ? (
        <SettingsField id="tax-region-kind" label={t("regionKind")}>
          <SearchableSelect
            id="tax-region-kind"
            value={kind}
            onValueChange={(next) => {
              setKind(next as RegionKind);
              setValue("");
              setLabel("");
            }}
            options={kinds.map((each) => ({ value: each, label: kindLabel(each) }))}
            ariaLabel={t("regionKind")}
            triggerClassName="w-full"
          />
        </SettingsField>
      ) : null}
      {kind === "postal_prefix" ? (
        <SettingsField
          id="tax-region-value"
          label={t("postalPrefix")}
          help={t("postalPrefixHelp")}
          error={value.trim() && !prefix ? t("postalInvalid") : undefined}
        >
          <Input id="tax-region-value" maxLength={20} value={value} aria-describedby="tax-region-value-note" onChange={(event) => setValue(event.target.value)} />
        </SettingsField>
      ) : kind === "admin_area" ? (
        <SettingsField id="tax-region-value" label={t("adminArea")}>
          <SearchableSelect
            id="tax-region-value"
            value={value}
            onValueChange={setValue}
            options={areas.map((area) => ({ value: area.code, label: area.name, keywords: [area.code] }))}
            placeholder={t("chooseAdminArea")}
            searchPlaceholder={t("searchPlaces")}
            emptyMessage={t("noMatches")}
            ariaLabel={t("adminArea")}
            triggerClassName="w-full"
          />
        </SettingsField>
      ) : (
        <SettingsField id="tax-region-value" label={t(kind)}>
          {/* Every active place of this type, searched on the server; its parents tell same-named places apart. */}
          <SearchableSelect
            id="tax-region-value"
            value={value}
            selectedLabel={label || undefined}
            load={deliveryLocationLoader({ type: kind })}
            queryKey={[...queryKeys.settings.deliveryLocations(), "picker", kind, null, false]}
            onValueChange={(next, option) => {
              setValue(next);
              setLabel(option?.label ?? "");
            }}
            placeholder={t("choosePlace")}
            searchPlaceholder={t("searchPlaces")}
            emptyMessage={t("noMatches")}
            ariaLabel={t(kind)}
            required
            triggerClassName="w-full"
          />
        </SettingsField>
      )}
    </>
  );
}

function RemoveRegion({ region, label, onRemoved }: { region: TaxRegionRecord; label: string; onRemoved?: () => Promise<unknown> }) {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshTaxes();
  const failWrite = useWriteFailure();
  const [confirming, setConfirming] = useState(false);
  const country = region.kind === "country";
  const remove = useMutation({
    mutationFn: () => apiData(deleteApiV1AdminTaxesRegionsById({ path: { id: region.id }, query: { expectedVersion: region.version } })),
    onSuccess: async () => {
      toast.success(t("removed"));
      setConfirming(false);
      await (onRemoved ? onRemoved() : refresh());
    },
    onError: (error) => failWrite(error, t("removeFailed")),
  });
  const title = country ? t("removeCountry", { country: label }) : t("removeRegion", { name: label });
  return (
    <>
      <Button
        type="button"
        variant={country ? "destructive" : "ghost"}
        size={country ? "default" : "sm"}
        aria-label={country ? undefined : title}
        onClick={() => setConfirming(true)}
      >
        {country ? title : t("remove")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={title}
        description={country ? t("removeCountryBody") : t("removeRegionBody")}
        confirmLabel={t("remove")}
        cancelLabel={common("cancel")}
        isLoading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

// ── The page ────────────────────────────────────────────────────────────

export function TaxRegionPage({ regionId }: { regionId: string }) {
  const t = useMessages(taxesMessages);
  const nav = useMessages(settingsNavMessages);
  const canEdit = useCanManageTaxes();
  const navigate = useNavigate();
  const services = useTaxServices();
  const regionName = useRegionName();
  const groupName = useGroupName();
  const refresh = useRefreshTaxes();
  const detail = useQuery(taxRegionQueryOptions(regionId));
  const configuration = useQuery(taxConfigurationQueryOptions());
  const back = { to: "/admin/settings/taxes" as const, label: nav("taxes") };

  if (detail.isError || configuration.isError) {
    return (
      <SettingsPage page="taxes" back={back} title={nav("taxes")}>
        {isAdminApiNotFoundError(detail.error)
          ? <SettingsCard description={t("regionNotFound")} />
          : <SettingsLoadFailure title={t("loadRegions")} onRetry={() => Promise.all([detail.refetch(), configuration.refetch()])} />}
      </SettingsPage>
    );
  }
  if (!detail.data || !configuration.data) {
    return (
      <SettingsPage page="taxes" back={back} title={nav("taxes")}>
        <SettingsCardLoading />
      </SettingsPage>
    );
  }
  const { region, subRegions, rates } = detail.data;
  const config = configuration.data;
  const country = countryName(region.countryCode);
  const providerId = region.providerId ?? config.settings.providerId;
  const appProvider = providerId !== SYSTEM_TAX_PROVIDER_ID;
  const regionOf = (id: string) => (id === region.id ? null : subRegions.find((each) => each.id === id) ?? null);
  const hasGroups = config.classes.length > 0;
  return (
    <SettingsPage page="taxes" back={back} title={country} readOnly={!canEdit}>
      <ServiceCard key={`${region.id}:${region.version}`} region={region} storeProviderId={config.settings.providerId} />

      <SettingsCard
        title={t("ratesTitle")}
        description={appProvider
          ? t("appCalculates", { name: services.name(providerId), country })
          : !hasGroups ? t("addGroupFirst") : rates.length ? t("ratesDescription", { country }) : t("noRates")}
        action={
          <SettingsDialog
            title={t("addRate")}
            trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit || !hasGroups}>{t("addRate")}</Button>}
          >
            <RateForm rate={null} country={region} regions={subRegions} config={config} />
          </SettingsDialog>
        }
        rows={rates.length ? rates.map((rate) => {
          const where = regionOf(rate.taxRegionId);
          return (
            <SettingsDialog
              key={rate.id}
              title={t("editRate", { name: rate.name })}
              trigger={
                <SettingsRow
                  disabled={!canEdit}
                  label={
                    <span className="flex items-center gap-2">
                      {rate.name}
                      {rate.isActive ? null : <StatusBadge status="inactive">{t("inactive")}</StatusBadge>}
                    </span>
                  }
                  value={t("rateSummary", {
                    percent: basisPointsToPercent(rate.rateBps),
                    where: where ? regionName(where) : t("wholeCountry", { country }),
                    group: config.classes.find((group) => group.id === rate.taxClassId)
                      ? groupName(config.classes.find((group) => group.id === rate.taxClassId)!)
                      : t("unknownGroup"),
                  })}
                />
              }
            >
              <RateForm rate={rate} country={region} regions={subRegions} config={config} />
            </SettingsDialog>
          );
        }) : null}
      />

      <SettingsCard
        title={t("subRegionsTitle")}
        description={subRegions.length ? t(region.countryCode === BD ? "subRegionsBd" : "subRegionsOther") : t("noSubRegions")}
        action={
          <SettingsDialog
            title={t("addRegion")}
            trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addRegion")}</Button>}
          >
            <RegionForm country={region} regions={subRegions} />
          </SettingsDialog>
        }
        rows={subRegions.length ? subRegions.map((each) => (
          <div key={each.id} className="flex min-h-14 items-center gap-3 border-t border-border px-4 py-3 first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium">{regionName(each)}</span>
              <span className="block text-body text-muted-foreground">{t("groupRateCount", { count: each.rateCount })}</span>
            </span>
            {canEdit ? <RemoveRegion region={each} label={regionName(each)} /> : null}
          </div>
        )) : null}
      />

      {canEdit ? (
        <div>
          <RemoveRegion
            region={region}
            label={country}
            onRemoved={async () => {
              await navigate({ to: "/admin/settings/taxes", search: {} });
              await refresh();
            }}
          />
        </div>
      ) : null}
    </SettingsPage>
  );
}
