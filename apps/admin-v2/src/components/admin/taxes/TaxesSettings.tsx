import { useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminTaxesClassesById,
  deleteApiV1AdminTaxesRatesById,
  postApiV1AdminTaxesClasses,
  postApiV1AdminTaxesPreview,
  postApiV1AdminTaxesRates,
  putApiV1AdminTaxesClassesById,
  putApiV1AdminTaxesClassificationsByKindById,
  putApiV1AdminTaxesRatesById,
  putApiV1AdminTaxesSettings,
} from "@scalius/api-client/sdk";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import {
  fetchTaxSettings,
  taxClassificationsQueryOptions,
  taxConfigurationQueryOptions,
  taxSettingsQueryOptions,
  type TaxClassificationItem,
  type TaxClassificationKind,
  type TaxClassRecord,
  type TaxConfigurationPayload,
  type TaxJurisdictionType,
  type TaxRateRecord,
  type TaxSettingsRecord,
} from "~/lib/api-query-options/taxes";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "@scalius/shared/utils";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { taxesMessages } from "~/i18n/settings-taxes";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useSaveBar } from "../shared/SaveBar";
import { SettingsLoadFailure } from "../settings/SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "../settings/SettingsPage";
import {
  basisPointsToPercent,
  getRequiredTaxRateRoles,
  percentToBasisPoints,
  resolveJurisdictionSelection,
  taxSettingsIssue,
} from "./tax-form";

const NONE = "__none__";
const OVERRIDES_PAGE_SIZE = 25;
const configurationQuery = taxConfigurationQueryOptions();
const taxSettingsQuery = taxSettingsQueryOptions();
export const firstTaxOverridesQuery = taxClassificationsQueryOptions({
  kind: "product",
  page: 1,
  limit: OVERRIDES_PAGE_SIZE,
});

function useCanManageTaxes() {
  return useHasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
}

/**
 * Tax writes carry the version they were read at. A stale one is refused:
 * reload the latest and ask the merchant to save again.
 */
function useWriteFailure() {
  const queryClient = useQueryClient();
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  return async (error: unknown, conflictMessage = t("conflict")) => {
    if (!isAdminApiConflictError(error)) {
      toast.error(common("saveFailed"));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    toast.error(conflictMessage);
  };
}

function useRefreshTaxes() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
}

function SwitchRow({
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 text-body">
      <span>
        <span className="block font-medium">{label}</span>
        {help ? <span className="block text-muted-foreground">{help}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  );
}

function useGroupName() {
  const t = useMessages(taxesMessages);
  return (group: TaxClassRecord) => (group.isExempt ? t("taxFreeName", { name: group.name }) : group.name);
}

// ── Tax collection ──────────────────────────────────────────────────────

export function TaxCollectionCard() {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const canEdit = useCanManageTaxes();
  const groupName = useGroupName();
  const configuration = useQuery(configurationQuery);
  const config = configuration.data;
  const { values, setValue, isLoadError, refetch } = useSettingsForm<TaxSettingsRecord, TaxSettingsRecord>({
    label: t("collectionTitle"),
    queryKey: taxSettingsQuery.queryKey,
    fetchFn: fetchTaxSettings,
    saveFn: async (draft) => {
      try {
        const saved = await apiData(putApiV1AdminTaxesSettings({
          body: {
            expectedVersion: draft.version,
            enabled: draft.enabled,
            pricesIncludeTax: draft.pricesIncludeTax,
            taxShipping: draft.taxShipping,
            defaultTaxClassId: draft.defaultTaxClassId,
            shippingTaxClassId: draft.taxShipping ? draft.shippingTaxClassId : null,
            displayLabel: draft.displayLabel.trim(),
          },
        }));
        return saved.settings;
      } catch (error) {
        if (!isAdminApiConflictError(error)) throw new Error(common("saveFailed"));
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
        throw new Error(t("conflict"));
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

  return (
    <SettingsCard id="taxCollection" title={t("collectionTitle")}>
      <SwitchRow
        label={t("collect")}
        help={t("collectHelp")}
        checked={values.enabled}
        disabled={!canEdit}
        onCheckedChange={(on) => setValue("enabled", on)}
      />
      <SettingsField id="tax-default-group" label={t("defaultGroup")} help={t("defaultGroupHelp")} error={errorFor("default")}>
        <Select
          value={values.defaultTaxClassId ?? NONE}
          disabled={!canEdit}
          onValueChange={(value) => setValue("defaultTaxClassId", value === NONE ? null : value)}
        >
          <SelectTrigger id="tax-default-group" aria-describedby="tax-default-group-note"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("none")}</SelectItem>
            {groups.map((group) => <SelectItem key={group.id} value={group.id}>{groupName(group)}</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsField>
      <SwitchRow
        label={t("pricesInclude")}
        help={t("pricesIncludeHelp")}
        checked={values.pricesIncludeTax}
        disabled={!canEdit}
        onCheckedChange={(on) => setValue("pricesIncludeTax", on)}
      />
      <SwitchRow
        label={t("taxDelivery")}
        checked={values.taxShipping}
        disabled={!canEdit}
        onCheckedChange={(on) => setValue("taxShipping", on)}
      />
      {values.taxShipping ? (
        <SettingsField id="tax-delivery-group" label={t("deliveryGroup")} error={errorFor("delivery")}>
          <Select
            value={values.shippingTaxClassId ?? NONE}
            disabled={!canEdit}
            onValueChange={(value) => setValue("shippingTaxClassId", value === NONE ? null : value)}
          >
            <SelectTrigger id="tax-delivery-group" aria-describedby="tax-delivery-group-note"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("sameAsDefault")}</SelectItem>
              {groups.map((group) => <SelectItem key={group.id} value={group.id}>{groupName(group)}</SelectItem>)}
            </SelectContent>
          </Select>
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
    </SettingsCard>
  );
}

// ── Tax groups ──────────────────────────────────────────────────────────

function GroupForm({ group, config }: { group: TaxClassRecord | null; config: TaxConfigurationPayload }) {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshTaxes();
  const failWrite = useWriteFailure();
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
    onError: (error) => failWrite(error),
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
    dirty: draft.name !== saved.name || draft.isExempt !== saved.isExempt,
    saving: save.isPending,
    invalid: !draft.name.trim() || nameTaken || needsRate,
    save: () => save.mutateAsync(),
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
            title={t("deleteGroup")}
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

// ── Rates ───────────────────────────────────────────────────────────────

interface RateDraft {
  name: string;
  percent: string;
  taxClassId: string;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId: string;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

function toRateDraft(rate: TaxRateRecord | null, config: TaxConfigurationPayload): RateDraft {
  return {
    name: rate?.name ?? "",
    percent: rate ? basisPointsToPercent(rate.rateBps) : "",
    taxClassId: rate?.taxClassId ?? config.settings.defaultTaxClassId ?? config.classes[0]?.id ?? "",
    jurisdictionType: rate?.jurisdictionType ?? "all",
    jurisdictionId: rate?.jurisdictionId ?? "",
    priority: String(rate?.priority ?? 0),
    isCompound: rate?.isCompound ?? false,
    isActive: rate?.isActive ?? true,
  };
}

function RateForm({ rate, config }: { rate: TaxRateRecord | null; config: TaxConfigurationPayload }) {
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefreshTaxes();
  const failWrite = useWriteFailure();
  const groupName = useGroupName();
  const [saved] = useState(() => toRateDraft(rate, config));
  const [draft, setDraft] = useState(saved);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof RateDraft>(key: K, value: RateDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const rateBps = percentToBasisPoints(draft.percent);
  const priority = /^\d{1,4}$/.test(draft.priority) && Number(draft.priority) <= 1000 ? Number(draft.priority) : null;
  const place = resolveJurisdictionSelection(draft.jurisdictionType, draft.jurisdictionId, config.jurisdictions);
  const places = config.jurisdictions.filter((option) => option.type === draft.jurisdictionType);
  const roles = getRequiredTaxRateRoles(config, rate);
  const breaksCoverage = roles.length > 0 && (!draft.isActive || draft.taxClassId !== rate?.taxClassId);
  const onlyRateNote = roles.length === 2 ? t("onlyRateBoth") : roles[0] === "delivery" ? t("onlyRateDelivery") : t("onlyRateProducts");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        taxClassId: draft.taxClassId,
        name: draft.name.trim(),
        rateBps: rateBps!,
        jurisdictionType: draft.jurisdictionType,
        jurisdictionId: place!.jurisdictionId,
        jurisdictionLabel: place!.jurisdictionLabel,
        priority: priority!,
        isCompound: draft.isCompound,
        isActive: draft.isActive,
      };
      return rate
        ? apiData(putApiV1AdminTaxesRatesById({ path: { id: rate.id }, body: { ...body, expectedVersion: rate.version } }))
        : apiData(postApiV1AdminTaxesRates({ body }));
    },
    onSuccess: refresh,
    onError: (error) => failWrite(error),
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
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    saving: save.isPending,
    invalid: !draft.name.trim() || rateBps === null || priority === null || !draft.taxClassId || !place || breaksCoverage,
    save: () => save.mutateAsync(),
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
        <Select value={draft.taxClassId} onValueChange={(value) => set("taxClassId", value)}>
          <SelectTrigger id="tax-rate-group"><SelectValue placeholder={t("chooseGroup")} /></SelectTrigger>
          <SelectContent>
            {config.classes.map((group) => <SelectItem key={group.id} value={group.id}>{groupName(group)}</SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsField>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id="tax-rate-where" label={t("where")}>
          <Select
            value={draft.jurisdictionType}
            onValueChange={(value) => setDraft({ ...draft, jurisdictionType: value as TaxJurisdictionType, jurisdictionId: "" })}
          >
            <SelectTrigger id="tax-rate-where"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["all", "city", "zone", "area"] as const).map((type) => <SelectItem key={type} value={type}>{t(type)}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsField>
        {draft.jurisdictionType !== "all" ? (
          <SettingsField
            id="tax-rate-place"
            label={t(draft.jurisdictionType)}
            error={places.length === 0 ? t("noPlaces") : undefined}
          >
            <SearchableSelect
              id="tax-rate-place"
              value={draft.jurisdictionId}
              options={places.map((option) => ({ value: option.id, label: option.name }))}
              onValueChange={(value) => set("jurisdictionId", value)}
              placeholder={t("choosePlace")}
              searchPlaceholder={t("searchPlaces")}
              emptyMessage={t("noMatches")}
              ariaLabel={t(draft.jurisdictionType)}
              required
              maxVisibleOptions={100}
              triggerClassName="w-full"
            />
          </SettingsField>
        ) : null}
      </div>
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
            title={t("deleteRate")}
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

function money(amount: number, currency: string) {
  return formatNumber(amount, { style: "currency", currency, maximumFractionDigits: 2 });
}

/** Runs the saved setup on a sample order; the server does the math. */
function TryItRow({ config }: { config: TaxConfigurationPayload }) {
  const t = useMessages(taxesMessages);
  const groupName = useGroupName();
  const [price, setPrice] = useState("1000");
  const [delivery, setDelivery] = useState("0");
  const [group, setGroup] = useState(NONE);
  const [city, setCity] = useState("");
  const [zone, setZone] = useState("");
  const [area, setArea] = useState("");
  const options = (type: "city" | "zone" | "area", parentId: string) =>
    config.jurisdictions
      .filter((option) => option.type === type && (type === "city" || option.parentId === parentId))
      .map((option) => ({ value: option.id, label: option.name }));
  const amount = Number(price);
  const deliveryAmount = Number(delivery || "0");
  const ready = price.trim() !== "" && amount >= 0 && deliveryAmount >= 0 && Boolean(city && zone);
  const preview = useMutation({
    mutationFn: () =>
      apiData(postApiV1AdminTaxesPreview({
        body: {
          amount,
          quantity: 1,
          shippingAmount: deliveryAmount,
          discountAmount: 0,
          taxClassId: group === NONE ? null : group,
          city,
          zone,
          area: area || null,
        },
      })),
  });
  const result = preview.data;
  const place = (
    id: string,
    type: "city" | "zone" | "area",
    value: string,
    onChange: (value: string) => void,
    parentId = "",
  ) => (
    <SettingsField id={id} label={t(type)}>
      <SearchableSelect
        id={id}
        value={value}
        options={options(type, parentId)}
        onValueChange={onChange}
        disabled={type !== "city" && !parentId}
        placeholder={t("choosePlace")}
        searchPlaceholder={t("searchPlaces")}
        emptyMessage={t("noMatches")}
        ariaLabel={t(type)}
        maxVisibleOptions={100}
        triggerClassName="w-full"
      />
    </SettingsField>
  );

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
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger id="tax-try-group"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("useDefault")}</SelectItem>
                {config.classes.map((item) => <SelectItem key={item.id} value={item.id}>{groupName(item)}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsField>
          {config.jurisdictions.some((option) => option.type === "city") ? (
            <div className="grid gap-4 sm:grid-cols-3">
              {place("tax-try-city", "city", city, (value) => { setCity(value); setZone(""); setArea(""); })}
              {place("tax-try-zone", "zone", zone, (value) => { setZone(value); setArea(""); }, city)}
              {place("tax-try-area", "area", area, setArea, zone)}
            </div>
          ) : (
            <p className="text-body text-muted-foreground">{t("noPlaces")}</p>
          )}
          <Button type="button" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>
            {preview.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
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

export function TaxRatesCard() {
  const t = useMessages(taxesMessages);
  const canEdit = useCanManageTaxes();
  const { data: config, isError, refetch } = useQuery(configurationQuery);
  if (isError) return <SettingsLoadFailure title={t("loadRates")} onRetry={refetch} />;
  if (!config) return <SettingsCardLoading />;
  const groupLabel = (id: string) => config.classes.find((group) => group.id === id)?.name ?? t("unknownGroup");
  const hasGroups = config.classes.length > 0;
  return (
    <SettingsCard id="taxRates"
      title={t("ratesTitle")}
      description={!hasGroups ? t("addGroupFirst") : config.rates.length ? undefined : t("noRates")}
      action={
        <SettingsDialog
          title={t("addRate")}
          trigger={<Button type="button" variant="outline" size="sm" disabled={!canEdit || !hasGroups}>{t("addRate")}</Button>}
        >
          <RateForm rate={null} config={config} />
        </SettingsDialog>
      }
      rows={
        config.rates.length ? (
          <>
            {config.rates.map((rate) => (
              <SettingsDialog
                key={rate.id}
                title={t("editRate", { name: rate.name })}
                trigger={
                  <SettingsRow
                    disabled={!canEdit}
                    label={
                      <span className="flex items-center gap-2">
                        {rate.name}
                        {rate.isActive ? null : <Badge variant="secondary">{t("inactive")}</Badge>}
                      </span>
                    }
                    value={t("rateSummary", {
                      percent: basisPointsToPercent(rate.rateBps),
                      where: rate.jurisdictionType === "all" ? t("all") : rate.jurisdictionLabel ?? t(rate.jurisdictionType),
                      group: groupLabel(rate.taxClassId),
                    })}
                  />
                }
              >
                <RateForm rate={rate} config={config} />
              </SettingsDialog>
            ))}
            <TryItRow config={config} />
          </>
        ) : null
      }
    />
  );
}

// ── Overrides ───────────────────────────────────────────────────────────

function OverrideForm({ item, groups }: { item: TaxClassificationItem; groups: TaxClassRecord[] }) {
  const t = useMessages(taxesMessages);
  const queryClient = useQueryClient();
  const failWrite = useWriteFailure();
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
    onError: async (error) => {
      if (isAdminApiConflictError(error)) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxClassifications() });
      }
      await failWrite(error);
    },
  });
  useSaveBar({ dirty: draft !== saved, saving: save.isPending, save: () => save.mutateAsync(), discard: () => setDraft(saved) });
  return (
    <SettingsField id="tax-override-group" label={t("rateGroup")}>
      <Select value={draft} onValueChange={setDraft}>
        <SelectTrigger id="tax-override-group"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{item.kind === "variant" ? t("sameAsProduct") : t("useDefault")}</SelectItem>
          {groups.map((group) => <SelectItem key={group.id} value={group.id}>{groupName(group)}</SelectItem>)}
        </SelectContent>
      </Select>
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
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as TaxClassificationKind);
            setSearchDraft("");
            setSearch("");
            setPage(1);
          }}
        >
          <SelectTrigger className="sm:w-40" aria-label={t("show")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="product">{t("products")}</SelectItem>
            <SelectItem value="variant">{t("variants")}</SelectItem>
          </SelectContent>
        </Select>
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
