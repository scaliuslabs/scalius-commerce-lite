// Settings → Taxes (MARKETS-DESIGN step 3c), Shopify's "Taxes and duties":
// how tax is collected and by which service, the countries the store
// collects tax in (each opens its own page with its rates and regions),
// tax groups and product overrides. Whether prices include tax is each
// market's (Settings → Markets).
import { useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { toast } from "~/lib/toast";
import {
  deleteApiV1AdminTaxesClassesById,
  postApiV1AdminTaxesClasses,
  postApiV1AdminTaxesPreview,
  postApiV1AdminTaxesRegions,
  putApiV1AdminTaxesClassesById,
  putApiV1AdminTaxesClassificationsByKindById,
  putApiV1AdminTaxesSettings,
} from "@scalius/api-client/sdk";
import { SYSTEM_TAX_PROVIDER_ID } from "@scalius/shared/plugins/providers/kinds";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { EMPTY_LOCATION, LocationPicker, type LocationValue } from "~/components/admin/location/LocationPicker";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { AdminApiResponseError, isAdminApiConflictError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { countryName } from "~/lib/country-name";
import {
  OVERRIDES_PAGE_SIZE,
  fetchTaxSettings,
  taxClassificationsQueryOptions,
  taxConfigurationQueryOptions,
  taxSettingsQueryOptions,
  type TaxClassificationItem,
  type TaxClassificationKind,
  type TaxClassRecord,
  type TaxConfigurationPayload,
  type TaxSettingsRecord,
} from "~/lib/api-query-options/taxes";
import { appProvidersQuery } from "~/lib/api-query-options/settings-screens";
import { addressCountriesQueryOptions, addressRulesQueryOptions } from "~/lib/api-query-options/address-rules";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { taxesMessages } from "~/i18n/settings-taxes";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { useOpenAppProvider } from "../apps/AppProviderSheetHost";
import { AppProviderStatus, appProviderOption } from "../settings/AppProviderStatus";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "../settings/SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "../settings/SettingsPage";
import { basisPointsToPercent, taxSettingsIssue } from "./tax-form";
import {
  NONE,
  SwitchRow,
  money,
  useCanManageTaxes,
  useGroupName,
  useRefreshTaxes,
  useSaveFailure,
  useWriteFailure,
} from "./tax-shared";

const configurationQuery = taxConfigurationQueryOptions();
const taxSettingsQuery = taxSettingsQueryOptions();

/** Every country an address can be in, by name in the dashboard language. */
function useCountryOptions(except: ReadonlySet<string> = new Set()) {
  const codes = useQuery(addressCountriesQueryOptions()).data ?? [];
  return codes
    .filter((code) => !except.has(code))
    .map((code) => ({ value: code, label: countryName(code), keywords: [code] }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** The tax services a merchant can choose: the built-in rates, then installed apps. */
export function useTaxServices() {
  const t = useMessages(taxesMessages);
  const apps = useMessages(appProvidersMessages);
  const { canView } = useProviderPortAccess("tax");
  const providers = useQuery({ ...appProvidersQuery("tax"), enabled: canView });
  const options = [
    { value: SYSTEM_TAX_PROVIDER_ID, label: t("systemService") },
    ...(providers.data ?? []).map((provider) => appProviderOption(provider, apps)),
  ];
  const name = (id: string | null | undefined) =>
    options.find((option) => option.value === (id ?? SYSTEM_TAX_PROVIDER_ID))?.label ?? id ?? t("systemService");
  return { options, name, hasApps: (providers.data?.length ?? 0) > 0, providers: providers.data ?? [] };
}

// ── Tax collection ──────────────────────────────────────────────────────

export function TaxCollectionCard() {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanManageTaxes();
  const groupName = useGroupName();
  const services = useTaxServices();
  const openProvider = useOpenAppProvider();
  const canSeeApps = useHasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const configuration = useQuery(configurationQuery);
  const config = configuration.data;
  const { values, setValue, isLoadError, refetch } = useSettingsForm<TaxSettingsRecord, TaxSettingsRecord>({
    label: t("collectionTitle"),
    fields: { label: "tax-label" },
    queryKey: taxSettingsQuery.queryKey,
    fetchFn: fetchTaxSettings,
    saveFn: async (draft) => {
      try {
        const saved = await apiData(putApiV1AdminTaxesSettings({
          body: {
            expectedVersion: draft.version,
            enabled: draft.enabled,
            taxShipping: draft.taxShipping,
            defaultTaxClassId: draft.defaultTaxClassId,
            shippingTaxClassId: draft.taxShipping ? draft.shippingTaxClassId : null,
            displayLabel: draft.displayLabel.trim(),
            providerId: draft.providerId,
          },
        }));
        return saved.settings;
      } catch (error) {
        if (!isAdminApiConflictError(error)) throw new Error(common("saveFailed"));
        // A 409 is either the version check (someone else saved first) or a rule the
        // draft breaks (a taxed group without a rate), whose own words say what to fix.
        // Only a moved version is the settings conflict whose banner offers
        // "Reload and keep my edits" (the card's reload merges the newer version under the edits).
        const latest = await fetchTaxSettings().catch(() => null);
        if (!latest || latest.version === draft.version) throw error;
        throw new AdminApiResponseError(t("conflict"), 409, "SETTINGS_REVISION_CONFLICT", {
          document: "tax",
          expectedRevision: draft.version,
          currentRevision: latest.version,
        });
      }
    },
    resolveSavedValues: (saved) => saved,
    invalidateQueryKeys: [configurationQuery.queryKey],
    defaultValues: {} as TaxSettingsRecord,
    errorMessage: common("saveFailed"),
    canEdit,
    // Fail closed: saving waits for the groups and rates the draft is checked against.
    isValid: (draft) => Boolean(config) && taxSettingsIssue(draft, config!) === null,
  });

  if (values.version === undefined && !isLoadError) return <SettingsCardLoading />;
  if (isLoadError || configuration.isError || values.version === undefined) {
    return (
      <SettingsLoadFailure
        title={t("loadSettings")}
        onRetry={() => Promise.all([refetch(), configuration.refetch()])}
      />
    );
  }
  const issue = config ? taxSettingsIssue(values, config) : null;
  const errorFor = (field: "label" | "default" | "delivery") => {
    if (issue?.field !== field) return undefined;
    return issue.key === "groupNeedsRate" ? t("groupNeedsRate", { name: issue.name }) : t(issue.key);
  };
  const groups = config?.classes ?? [];

  const appService = services.providers.find((provider) => provider.id === values.providerId) ?? null;
  return (
    <SettingsCard id="taxCollection" title={t("collectionTitle")}>
      <SwitchRow
        label={t("collect")}
        help={t("collectHelp")}
        checked={values.enabled}
        disabled={!canEdit}
        onCheckedChange={(on) => setValue("enabled", on)}
      />
      {services.hasApps || values.providerId !== SYSTEM_TAX_PROVIDER_ID ? (
        <SettingsField id="tax-service" label={t("service")} help={t("serviceHelp")}>
          <SearchableSelect
            id="tax-service"
            aria-describedby="tax-service-note"
            value={values.providerId}
            disabled={!canEdit}
            onValueChange={(value) => {
              setValue("providerId", value);
              // An app tax service not set up yet opens its own setup.
              const chosen = services.providers.find((provider) => provider.id === value);
              if (chosen && !chosen.readiness.configured && canSeeApps) openProvider?.(chosen.id);
            }}
            options={services.options}
            ariaLabel={t("service")}
            triggerClassName="w-full"
          />
        </SettingsField>
      ) : null}
      {appService ? <AppProviderStatus provider={appService} /> : null}
      <SettingsField id="tax-default-group" label={t("defaultGroup")} help={t("defaultGroupHelp")} error={errorFor("default")}>
        <SearchableSelect
          id="tax-default-group"
          aria-describedby="tax-default-group-note"
          value={values.defaultTaxClassId ?? NONE}
          disabled={!canEdit}
          onValueChange={(value) => setValue("defaultTaxClassId", value === NONE ? null : value)}
          options={[{ value: NONE, label: t("none") }, ...groups.map((group) => ({ value: group.id, label: groupName(group) }))]}
          ariaLabel={t("defaultGroup")}
          triggerClassName="w-full"
        />
      </SettingsField>
      <SwitchRow
        label={t("taxDelivery")}
        checked={values.taxShipping}
        disabled={!canEdit}
        onCheckedChange={(on) => setValue("taxShipping", on)}
      />
      {values.taxShipping ? (
        <SettingsField id="tax-delivery-group" label={t("deliveryGroup")} error={errorFor("delivery")}>
          <SearchableSelect
            id="tax-delivery-group"
            aria-describedby="tax-delivery-group-note"
            value={values.shippingTaxClassId ?? NONE}
            disabled={!canEdit}
            onValueChange={(value) => setValue("shippingTaxClassId", value === NONE ? null : value)}
            options={[{ value: NONE, label: t("sameAsDefault") }, ...groups.map((group) => ({ value: group.id, label: groupName(group) }))]}
            ariaLabel={t("deliveryGroup")}
            triggerClassName="w-full"
          />
        </SettingsField>
      ) : null}
      <SettingsField id="tax-label" label={t("label")} help={t("labelHelp")} error={errorFor("label")}>
        <Input
          id="tax-label"
          maxLength={80}
          disabled={!canEdit}
          value={values.displayLabel}
          aria-describedby="tax-label-note"
          onChange={(event) => setValue("displayLabel", event.target.value)}
        />
      </SettingsField>
      <p className="text-body text-muted-foreground">
        {t("pricesInMarkets")}{" "}
        <Link to="/admin/settings/markets" className="text-foreground underline">{t("marketsLink")}</Link>
      </p>
    </SettingsCard>
  );
}

// ── Tax groups ──────────────────────────────────────────────────────────

function GroupForm({ group, config }: { group: TaxClassRecord | null; config: TaxConfigurationPayload }) {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshTaxes();
  const failWrite = useWriteFailure();
  const saveFailure = useSaveFailure();
  const [saved] = useState(() => ({ name: group?.name ?? "", isExempt: group?.isExempt ?? false }));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { settings } = config;
  const deliveryGroupId = settings.taxShipping ? settings.shippingTaxClassId ?? settings.defaultTaxClassId : null;
  const inSettings = Boolean(group) && (settings.defaultTaxClassId === group?.id || deliveryGroupId === group?.id);
  const inUse = inSettings || config.rates.some((rate) => rate.taxClassId === group?.id);
  const nameTaken = config.classes.some(
    (other) => other.id !== group?.id && other.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
  );
  // Collecting tax needs a rate on every taxed group in use.
  const needsRate = settings.enabled && inSettings && group?.isExempt === true && !draft.isExempt
    && !config.rates.some((rate) => rate.isActive && rate.taxClassId === group?.id);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: draft.name.trim(), isExempt: draft.isExempt };
      return group
        ? apiData(putApiV1AdminTaxesClassesById({ path: { id: group.id }, body: { ...body, expectedVersion: group.version } }))
        : apiData(postApiV1AdminTaxesClasses({ body }));
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () =>
      apiData(deleteApiV1AdminTaxesClassesById({ path: { id: group!.id }, query: { expectedVersion: group!.version } })),
    onSuccess: async () => {
      toast.success(t("groupDeleted"));
      await refresh();
    },
    onError: (error) => failWrite(error, t("groupDeleteFailed")),
    onSettled: () => setConfirmDelete(false),
  });
  useSaveBar({
    fields: { name: "tax-group-name" },
    dirty: draft.name !== saved.name || draft.isExempt !== saved.isExempt,
    saving: save.isPending,
    invalid: !draft.name.trim() || nameTaken || needsRate,
    save: () => save.mutateAsync().catch(saveFailure),
    discard: () => setDraft(saved),
  });

  return (
    <>
      <SettingsField id="tax-group-name" label={t("groupName")} error={nameTaken ? t("groupNameTaken") : undefined}>
        <Input
          id="tax-group-name"
          maxLength={120}
          value={draft.name}
          aria-describedby="tax-group-name-note"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </SettingsField>
      <SwitchRow
        label={t("taxFree")}
        help={t("taxFreeHelp")}
        checked={draft.isExempt}
        onCheckedChange={(isExempt) => setDraft({ ...draft, isExempt })}
      />
      {needsRate ? <p role="alert" className="text-body text-destructive">{t("groupNeedsRateToTax")}</p> : null}
      {group ? (
        <div className="space-y-1.5">
          <Button type="button" variant="ghost" disabled={inUse} onClick={() => setConfirmDelete(true)}>
            {t("deleteGroup")}
          </Button>
          {inUse ? <p className="text-body text-muted-foreground">{t("groupInUse")}</p> : null}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={common("deleteNamed", { name: group.name })}
            description={t("deleteConfirm", { name: group.name })}
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

export function TaxGroupsCard() {
  const t = useMessages(taxesMessages);
  const canEdit = useCanManageTaxes();
  const groupName = useGroupName();
  const { data: config, isError, refetch } = useQuery(configurationQuery);
  if (isError) return <SettingsLoadFailure title={t("loadRates")} onRetry={refetch} />;
  if (!config) return <SettingsCardLoading />;
  return (
    <SettingsCard id="taxGroups"
      title={t("groupsTitle")}
      description={config.classes.length ? t("groupsDescription") : t("noGroups")}
      action={
        <SettingsDialog
          title={t("addGroup")}
          trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addGroup")}</Button>}
        >
          <GroupForm group={null} config={config} />
        </SettingsDialog>
      }
      rows={
        config.classes.length
          ? config.classes.map((group) => (
              <SettingsDialog
                key={group.id}
                title={t("editGroup", { name: group.name })}
                trigger={
                  <SettingsRow
                    disabled={!canEdit}
                    label={groupName(group)}
                    value={t("groupRateCount", { count: config.rates.filter((rate) => rate.taxClassId === group.id).length })}
                  />
                }
              >
                <GroupForm group={group} config={config} />
              </SettingsDialog>
            ))
          : null
      }
    />
  );
}


// ── Regions ─────────────────────────────────────────────────────────────

/** Add a country: the store starts collecting tax there, then sets its rates on its page. */
function AddCountryForm({ taken }: { taken: ReadonlySet<string> }) {
  const t = useMessages(taxesMessages);
  const navigate = useNavigate();
  const refresh = useRefreshTaxes();
  const saveFailure = useSaveFailure();
  const [country, setCountry] = useState("");
  const options = useCountryOptions(taken);
  const create = useMutation({
    mutationFn: () => apiData(postApiV1AdminTaxesRegions({ body: { countryCode: country } })),
    onSuccess: async ({ region }) => {
      await refresh();
      await navigate({ to: "/admin/settings/taxes", search: { region: region.id } });
    },
  });
  useSaveBar({
    fields: { country: "tax-country" },
    dirty: country !== "",
    saving: create.isPending,
    invalid: !country,
    save: () => create.mutateAsync().catch(saveFailure),
    discard: () => setCountry(""),
  });
  return (
    <SettingsField id="tax-country" label={t("country")}>
      <SearchableSelect
        id="tax-country"
        value={country}
        onValueChange={setCountry}
        options={options}
        placeholder={t("chooseCountry")}
        searchPlaceholder={t("countrySearch")}
        emptyMessage={t("noMatches")}
        ariaLabel={t("country")}
        triggerClassName="w-full"
      />
    </SettingsField>
  );
}

/** Runs the saved setup on a sample order at an address; the server does the math. */
function TryItRow({ config }: { config: TaxConfigurationPayload }) {
  const t = useMessages(taxesMessages);
  const groupName = useGroupName();
  const countries = config.regions.filter((region) => region.kind === "country").map((region) => region.countryCode);
  const [country, setCountry] = useState(countries.includes("BD") ? "BD" : countries[0] ?? "BD");
  const [price, setPrice] = useState("1000");
  const [delivery, setDelivery] = useState("0");
  const [group, setGroup] = useState(NONE);
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION);
  const [adminArea, setAdminArea] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const rules = useQuery({ ...addressRulesQueryOptions(country), enabled: country !== "BD" });
  const countryOptions = useCountryOptions();
  const city = location.city?.id ?? "";
  const zone = location.zone?.id ?? "";
  const area = location.area?.id ?? "";
  const amount = Number(price);
  const deliveryAmount = Number(delivery || "0");
  const bd = country === "BD";
  const ready = price.trim() !== "" && amount >= 0 && deliveryAmount >= 0 && (!bd || Boolean(city && zone));
  const preview = useMutation({
    mutationFn: () =>
      apiData(postApiV1AdminTaxesPreview({
        body: {
          amount,
          quantity: 1,
          shippingAmount: deliveryAmount,
          discountAmount: 0,
          taxClassId: group === NONE ? null : group,
          countryCode: country,
          ...(bd
            ? { city, zone, area: area || null }
            : { adminArea: adminArea || null, postalCode: postalCode.trim() || null }),
        },
      })),
  });
  const result = preview.data;
  const areas = rules.data?.adminAreas ?? [];
  return (
    <Dialog onOpenChange={() => preview.reset()}>
      <DialogTrigger asChild>
        <SettingsRow label={t("tryIt")} value={t("tryItValue")} />
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("tryIt")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField id="tax-try-price" label={t("price")}>
              <Input id="tax-try-price" type="number" min="0" step="0.01" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </SettingsField>
            <SettingsField id="tax-try-delivery" label={t("deliveryCharge")}>
              <Input id="tax-try-delivery" type="number" min="0" step="0.01" inputMode="decimal" value={delivery} onChange={(event) => setDelivery(event.target.value)} />
            </SettingsField>
          </div>
          <SettingsField id="tax-try-group" label={t("rateGroup")}>
            <SearchableSelect
              id="tax-try-group"
              value={group}
              onValueChange={setGroup}
              options={[{ value: NONE, label: t("useDefault") }, ...config.classes.map((item) => ({ value: item.id, label: groupName(item) }))]}
              ariaLabel={t("rateGroup")}
              triggerClassName="w-full"
            />
          </SettingsField>
          <SettingsField id="tax-try-country" label={t("country")}>
            <SearchableSelect
              id="tax-try-country"
              value={country}
              onValueChange={(value) => {
                setCountry(value);
                setAdminArea("");
                preview.reset();
              }}
              options={countryOptions}
              searchPlaceholder={t("countrySearch")}
              emptyMessage={t("noMatches")}
              ariaLabel={t("country")}
              triggerClassName="w-full"
            />
          </SettingsField>
          {bd ? (
            <LocationPicker
              className="sm:grid-cols-3"
              ids={{ city: "tax-try-city", zone: "tax-try-zone", area: "tax-try-area" }}
              required={{ city: true, zone: true }}
              value={location}
              onChange={setLocation}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {areas.length > 0 ? (
                <SettingsField id="tax-try-admin-area" label={t("adminArea")}>
                  <SearchableSelect
                    id="tax-try-admin-area"
                    value={adminArea || NONE}
                    onValueChange={(value) => setAdminArea(value === NONE ? "" : value)}
                    options={[{ value: NONE, label: t("none") }, ...areas.map((entry) => ({ value: entry.code, label: entry.name, keywords: [entry.code] }))]}
                    ariaLabel={t("adminArea")}
                    triggerClassName="w-full"
                  />
                </SettingsField>
              ) : null}
              <SettingsField id="tax-try-postal" label={t("postalCode")}>
                <Input id="tax-try-postal" maxLength={40} value={postalCode} onChange={(event) => setPostalCode(event.target.value)} />
              </SettingsField>
            </div>
          )}
          <Button type="button" loading={preview.isPending} disabled={!ready} onClick={() => preview.mutate()}>
            {t("calculate")}
          </Button>
          {preview.isError ? <p role="alert" className="text-body text-destructive">{t("tryFailed")}</p> : null}
          {result ? (
            <dl className="space-y-2 border-t border-border pt-4 text-body" aria-live="polite">
              {result.components.map((component, index) => (
                <div key={`${component.name}:${index}`} className="flex justify-between gap-4 text-muted-foreground">
                  <dt>{component.name} · {basisPointsToPercent(component.rateBps)}%</dt>
                  <dd>{money(component.amountMinor / 10 ** result.decimalPlaces, result.currencyCode)}</dd>
                </div>
              ))}
              {result.components.length === 0 ? <p className="text-muted-foreground">{t("noMatchingRate")}</p> : null}
              <div className="flex justify-between gap-4 font-medium">
                <dt>{result.displayLabel}</dt>
                <dd>{money(result.taxAmount, result.currencyCode)}</dd>
              </div>
              <div className="flex justify-between gap-4 font-medium">
                <dt>{t("total")}</dt>
                <dd>{money(result.totalAmount, result.currencyCode)}</dd>
              </div>
              {result.pricesIncludeTax ? <p className="text-muted-foreground">{t("includedInPrice")}</p> : null}
            </dl>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TaxRegionsCard() {
  const t = useMessages(taxesMessages);
  const canEdit = useCanManageTaxes();
  const services = useTaxServices();
  const { data: config, isError, refetch } = useQuery(configurationQuery);
  if (isError) return <SettingsLoadFailure title={t("loadRegions")} onRetry={refetch} />;
  if (!config) return <SettingsCardLoading />;
  const countries = config.regions.filter((region) => region.kind === "country");
  const ratesIn = (countryCode: string) => {
    const ids = new Set(config.regions.filter((region) => region.countryCode === countryCode).map((region) => region.id));
    return config.rates.filter((rate) => ids.has(rate.taxRegionId)).length;
  };
  return (
    <SettingsCard
      id="taxRegions"
      title={t("regionsTitle")}
      description={countries.length ? t("regionsDescription") : t("noRegions")}
      action={
        <SettingsDialog
          title={t("addCountry")}
          trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit}>{t("addCountry")}</Button>}
        >
          <AddCountryForm taken={new Set(countries.map((region) => region.countryCode))} />
        </SettingsDialog>
      }
      rows={
        <>
          {countries.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead data-pin="primary">{t("country")}</TableHead>
                  <TableHead>{t("rates")}</TableHead>
                  <TableHead>{t("regionsColumn")}</TableHead>
                  <TableHead>{t("service")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {countries.map((region) => (
                  <TableRow key={region.id}>
                    <TableCell data-pin="primary">
                      <Link
                        to="/admin/settings/taxes"
                        search={{ region: region.id }}
                        className="break-words font-medium text-foreground hover:underline"
                      >
                        {countryName(region.countryCode)}
                      </Link>
                    </TableCell>
                    <TableCell>{ratesIn(region.countryCode)}</TableCell>
                    <TableCell>
                      {config.regions.filter((other) => other.countryCode === region.countryCode && other.kind !== "country").length}
                    </TableCell>
                    <TableCell>{services.name(region.providerId ?? config.settings.providerId)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <TryItRow config={config} />
        </>
      }
    />
  );
}

// ── Overrides ───────────────────────────────────────────────────────────

function OverrideForm({ item, groups }: { item: TaxClassificationItem; groups: TaxClassRecord[] }) {
  const t = useMessages(taxesMessages);
  const queryClient = useQueryClient();
  const overrideFailure = useSaveFailure(queryKeys.settings.taxClassifications());
  const groupName = useGroupName();
  const saved = item.taxClassId ?? NONE;
  const [draft, setDraft] = useState(saved);
  const save = useMutation({
    mutationFn: () =>
      apiData(putApiV1AdminTaxesClassificationsByKindById({
        path: { kind: item.kind, id: item.id },
        body: {
          taxClassId: draft === NONE ? null : draft,
          expectedVersion: item.version,
          expectedAggregateRevision: item.aggregateRevision,
        },
      })),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxClassifications() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.all }),
      ]),
  });
  useSaveBar({
    dirty: draft !== saved,
    saving: save.isPending,
    save: () => save.mutateAsync().catch(overrideFailure),
    discard: () => setDraft(saved),
  });
  return (
    <SettingsField id="tax-override-group" label={t("rateGroup")}>
      <SearchableSelect
        id="tax-override-group"
        value={draft}
        onValueChange={setDraft}
        options={[
          { value: NONE, label: item.kind === "variant" ? t("sameAsProduct") : t("useDefault") },
          ...groups.map((group) => ({ value: group.id, label: groupName(group) })),
        ]}
        ariaLabel={t("rateGroup")}
        triggerClassName="w-full"
      />
    </SettingsField>
  );
}

export function TaxOverridesCard() {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useCanManageTaxes();
  const [kind, setKind] = useState<TaxClassificationKind>("product");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const config = useQuery(configurationQuery);
  const list = useQuery({
    ...taxClassificationsQueryOptions({ kind, page, limit: OVERRIDES_PAGE_SIZE, search }),
    placeholderData: keepPreviousData,
  });
  if (list.isError || config.isError) {
    return (
      <SettingsLoadFailure
        title={t("loadOverrides")}
        onRetry={() => Promise.all([list.refetch(), config.refetch()])}
      />
    );
  }
  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / OVERRIDES_PAGE_SIZE));
  const items = list.data?.items ?? [];
  let rows: ReactNode = null;
  if (list.data && config.data) {
    const groups = config.data.classes;
    rows = items.length ? (
      items.map((item) => (
        <SettingsDialog
          key={`${item.kind}:${item.id}`}
          title={t("overrideFor", { name: item.label })}
          trigger={
            <SettingsRow
              disabled={!canEdit}
              label={item.label}
              value={item.taxClassName ?? (item.kind === "variant" ? t("sameAsProduct") : t("useDefault"))}
            />
          }
        >
          <OverrideForm item={item} groups={groups} />
        </SettingsDialog>
      ))
    ) : (
      <p className="px-4 py-4 text-body text-muted-foreground">{t("noItems")}</p>
    );
  }

  return (
    <SettingsCard id="taxOverrides"
      title={t("overridesTitle")}
      description={t("overridesDescription")}
      rows={
        <>
          {rows}
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 text-body text-muted-foreground">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("previous")}
                disabled={page <= 1 || list.isFetching}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <span>{t("pageOf", { page, total: totalPages })}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("next")}
                disabled={page >= totalPages || list.isFetching}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <SearchableSelect
          triggerClassName="sm:w-40"
          ariaLabel={t("show")}
          value={kind}
          onValueChange={(value) => {
            setKind(value as TaxClassificationKind);
            setSearchDraft("");
            setSearch("");
            setPage(1);
          }}
          options={[{ value: "product", label: t("products") }, { value: "variant", label: t("variants") }]}
        />
        <form
          method="get"
          role="search"
          className="flex flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
            setPage(1);
          }}
        >
          <Input
            value={searchDraft}
            maxLength={180}
            placeholder={kind === "product" ? t("searchProducts") : t("searchVariants")}
            aria-label={kind === "product" ? t("searchProducts") : t("searchVariants")}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <Button type="submit" variant="outline" size="icon" aria-label={common("search")}>
            <Search className="size-4" aria-hidden="true" />
          </Button>
        </form>
      </div>
    </SettingsCard>
  );
}
