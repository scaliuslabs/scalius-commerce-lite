import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "~/lib/toast";
import { formatList } from "@scalius/shared/locale-words";
import { getDecimalPlaces } from "@scalius/shared/currency";

import { DiscountSavedView } from "./DiscountSavedView";
import { ReadOnlyNotice } from "~/components/admin/states/ReadOnlyNotice";
import { announceSave, PresenceSlot, presenceKey } from "~/lib/realtime/store";
import { DiscountStatusBadge } from "./DiscountStatusBadge";
import {
  MAX_AMOUNT_MAJOR,
  MAX_CUSTOMER_SEGMENTS,
  MAX_QUANTITY,
  combinableClasses,
  combinationPreview,
  discountStatus,
  draftFromDiscount,
  draftToInput,
  emptyDraft,
  exceedsEveryPrice,
  generateDiscountCode,
  latinDigits,
  summarizeDraft,
  sameDiscountDraft,
  validateDraft,
  type DiscountDraft,
  type Scope,
  type SummaryFormat,
} from "./discount-form";
import type { DiscountType } from "./discount-kinds";
import { ScopeField, useScopeItems, useScopeLabel } from "./ScopeField";
import { SegmentField, useSegmentLabel, useSegmentNames } from "./SegmentField";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, SaveErrorBanner, useSaveBar, useSaveScope } from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ChoiceField, Field, FieldAction, FieldRow, FieldSet } from "~/components/ui/field";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, getLocale, useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { readPromotionRevisionConflict } from "~/lib/admin-api-conflicts";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { discountQueryOptions, discountsQueryOptions, type DiscountRecord } from "~/lib/api-query-options/discounts";
import {
  discountFailureText,
  useCreateDiscount,
  useDeleteDiscount,
  useSetDiscountActive,
  useUpdateDiscount,
} from "~/lib/api-mutations/discounts";
import { DateInput } from "~/components/ui/date-input";

type NumericField = "value" | "freeShippingMinimum" | "freeShippingMaxRate" | "minimumValue" | "buyValue" | "getQuantity" | "getValue" | "usesPerOrder" | "totalUses";

/** A number field that takes Bangla digits too (typed ১০ becomes 10); the symbol or "%" sits inside it (F3). */
function NumberInput({ value, whole, prefix, suffix, onValue }: {
  value: string;
  whole?: boolean;
  prefix?: string;
  suffix?: string;
  onValue: (value: string) => void;
}) {
  return (
    <Input
      inputMode={whole ? "numeric" : "decimal"}
      autoComplete="off"
      prefix={prefix}
      suffix={suffix}
      value={value}
      onChange={(event) => onValue(latinDigits(event.target.value))}
    />
  );
}

function CheckRow({ id, label, checked, onChange }: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <ChoiceField id={id} label={label} control={<Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />} />;
}

function RadioRow({ value, id, label }: { value: string; id: string; label: string }) {
  return <ChoiceField id={id} label={label} control={<RadioGroupItem value={value} id={id} />} />;
}

/** The API rejected the code because another discount already uses it. */
function isCodeTaken(error: unknown): boolean {
  return error instanceof AdminApiResponseError && error.status === 409 && /already in use/iu.test(error.message);
}

/**
 * Shopify-style discount editor for all four types: one column of cards, a
 * live summary beside it, and the contextual save bar ("Unsaved discount"
 * while creating), which saves, discards and guards leaving the page.
 */
export function DiscountEditor({ type, discount }: { type: DiscountType; discount?: DiscountRecord }) {
  const t = useMessages(discountsMessages);
  return (
    <SaveBarProvider
      unsavedLabel={discount ? undefined : t("unsavedDiscount")}
      savedMessage={t(discount ? "toastSaved" : "toastCreated")}
    >
      <EditorPage type={type} discount={discount} />
    </SaveBarProvider>
  );
}

function EditorPage({ type, discount }: { type: DiscountType; discount?: DiscountRecord }) {
  const t = useMessages(discountsMessages);
  const { symbol, code: currencyCode, fmt, priceIncrementMinor } = useCurrency();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = useSaveScope();
  const initial = useMemo(
    () => (discount ? draftFromDiscount(discount, currencyCode) : emptyDraft(type)),
    // The editor owns its draft; refetches must not overwrite unsaved work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discount?.id],
  );
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [revision, setRevision] = useState(discount?.revision ?? null);
  const [status, setStatus] = useState(discount?.status ?? "draft");
  const [conflict, setConflict] = useState(false);
  const [takenCode, setTakenCode] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const createMutation = useCreateDiscount();
  const updateMutation = useUpdateDiscount();
  const activeMutation = useSetDiscountActive();
  const deleteMutation = useDeleteDiscount();

  const canSave = hasPermission(discount ? ADMIN_PERMISSIONS.DISCOUNTS_EDIT : ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canDelete = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);
  const key = discount ? presenceKey("discount", discount.id) : null;
  const newerSaved = !canSave && discount && discount.revision > (revision ?? -1) ? discount : null;
  const savedDraft = newerSaved ? draftFromDiscount(newerSaved, currencyCode) : baseline;
  const savedRevision = newerSaved?.revision ?? revision;
  const savedStatus = newerSaved?.status ?? status;
  const view = canSave ? draft : savedDraft;
  const errors = validateDraft(draft, currencyCode, undefined, priceIncrementMinor);
  const dirty = canSave && !sameDiscountDraft(draft, baseline);
  const busy = Boolean(scope?.busy) || activeMutation.isPending || deleteMutation.isPending;
  const errorVars = {
    places: formatNumber(getDecimalPlaces(currencyCode)),
    max: fmt(MAX_AMOUNT_MAJOR),
    maxQuantity: formatNumber(MAX_QUANTITY),
    maxSegments: formatNumber(MAX_CUSTOMER_SEGMENTS),
  };
  // Messages show once Save is pressed; a finished end date is checked as soon as it's picked.
  const shown = (field: keyof DiscountDraft) =>
    errors[field] && (scope?.revealed || (field === "endDate" && draft.endDate)) ? t(errors[field]!, errorVars) : undefined;
  const codeTaken = takenCode !== null && draft.code.trim().toUpperCase() === takenCode;
  const codeError = shown("code") ?? (codeTaken ? t("errorCodeTaken") : undefined);

  const appliesItems = useScopeItems(view.appliesTo);
  const buyItems = useScopeItems(view.buyScope);
  const getItems = useScopeItems(view.getScope);
  const scopeLabel = useScopeLabel();
  const items = new Map([...appliesItems, ...buyItems, ...getItems]);
  const segments = useSegmentNames(view.eligibility === "segments");
  const segmentLabel = useSegmentLabel(segments.names);
  const fullSegments = (ids: string[]) => formatList(ids.map((id) => segments.names.get(id) ?? t(segments.query.isPending ? "loading" : segments.query.isError ? "loadFailed" : "segmentDeleted")), getLocale());
  const fullScope = (picked: Scope) => {
    const names = picked.ids.flatMap((id) => items.get(id)?.name ? [items.get(id)!.name] : []);
    const missing = picked.ids.filter((id) => !items.has(id));
    if (missing.length) names.push(scopeLabel({ kind: picked.kind, ids: missing }, new Map()));
    return formatList(names, getLocale());
  };
  const format: SummaryFormat = {
    money: (major) => fmt(Number(major)),
    number: (value) => formatNumber(Number(value)),
    date: (epoch) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium", timeStyle: "short" }),
    scope: canSave ? (picked: Scope) => scopeLabel(picked, items) : fullScope,
    segments: canSave ? segmentLabel : fullSegments,
  };
  // The live and scheduled discounts this one may combine with (a page of each).
  const live = useQuery(discountsQueryOptions({ view: "active", limit: 90 }));
  const later = useQuery(discountsQueryOptions({ view: "scheduled", limit: 90 }));
  const allDiscounts = [...(live.data?.discounts ?? []), ...(later.data?.discounts ?? [])];
  const preview = combinationPreview(view, allDiscounts, discount?.id);
  const summary = summarizeDraft(view, currencyCode, format, preview.filter((item) => item.stacks).length, priceIncrementMinor);
  // Each product's highest price buyers pay: an amount above all of them makes every item free.
  const prices = draft.appliesTo.ids.map((id) => appliesItems.get(id)?.priceRange?.to);
  const aboveEveryPrice = exceedsEveryPrice(
    draft,
    prices.every((price) => price !== undefined) ? (prices as number[]) : null,
    currencyCode,
  );
  const heading = view.method === "code" ? view.code.trim().toUpperCase() : view.title.trim();
  function update(patch: Partial<DiscountDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const numberField = (
    id: string,
    field: NumericField,
    label: string,
    { whole, help, money, percent }: { whole?: boolean; help?: string; money?: boolean; percent?: boolean } = {},
  ) => (
    <Field id={id} label={label} help={help} error={shown(field)}>
      <NumberInput
        whole={whole}
        prefix={money ? symbol : undefined}
        suffix={percent ? "%" : undefined}
        value={draft[field]}
        onValue={(value) => update({ [field]: value })}
      />
    </Field>
  );

  /** Runs inside the save bar: throws so the bar stays up and the banner explains. */
  async function save() {
    if (!canSave) return;
    const input = draftToInput(draft, currencyCode);
    try {
      if (!discount) {
        const created = await createMutation.mutateAsync({ input, activate: canToggle });
        await navigate({
          to: "/admin/discounts/$discountId",
          params: { discountId: created.id },
          replace: true,
          ignoreBlocker: true,
        });
        return;
      }
      const result = await updateMutation.mutateAsync({
        id: discount.id,
        input: { ...input, expectedRevision: revision ?? discount.revision },
      });
      setRevision(result.revision);
      setStatus(result.status);
      setBaseline(draft);
      if (key) announceSave(key, result.revision);
    } catch (error) {
      if (readPromotionRevisionConflict(error)) {
        setConflict(true);
        throw new Error(t("conflictTitle"));
      }
      if (draft.method === "code" && isCodeTaken(error)) {
        setTakenCode(draft.code.trim().toUpperCase());
        throw new Error(`${t("codeLabel")}: ${t("errorCodeTaken")}`);
      }
      throw error;
    }
  }

  useSaveBar({
    dirty,
    // Invalid drafts don't save: pressing Save shows what to fix.
    invalid: !canSave || Object.keys(errors).length > 0 || codeTaken,
    save,
    discard: () => setDraft(baseline),
  });

  async function loadTheirs() {
    if (!discount) return;
    try {
      const latest = await queryClient.fetchQuery({ ...discountQueryOptions(discount.id), staleTime: 0 });
      const next = draftFromDiscount(latest, currencyCode);
      // Clears the failed-save banner; the draft below replaces the discarded one.
      scope?.discardAll();
      setDraft(next);
      setBaseline(next);
      setRevision(latest.revision);
      setStatus(latest.status);
      setConflict(false);
    } catch (error) {
      toast.error(discountFailureText(error));
    }
  }

  /** Activate/Delete lost a race with another save: say so and offer their version. */
  function showConflict(error: unknown) {
    if (!readPromotionRevisionConflict(error)) {
      toast.error(discountFailureText(error));
      return;
    }
    setConflict(true);
    toast.error(t("conflictTitle"));
  }

  async function setActive(active: boolean) {
    if (!canToggle || !discount || savedRevision === null) return;
    try {
      const result = await activeMutation.mutateAsync({ id: discount.id, expectedRevision: savedRevision, active });
      setRevision(result.revision);
      setStatus(result.status);
      // A toggle adopts this saved snapshot; a later permission grant must not revive a stale draft under its newer revision.
      setBaseline(savedDraft);
      setDraft(savedDraft);
      if (key) announceSave(key, result.revision);
      toast.success(t(active ? "toastActivated" : "toastDeactivated"));
    } catch (error) {
      showConflict(error);
    }
  }

  async function remove() {
    if (!canDelete || !discount || savedRevision === null) return;
    try {
      await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: savedRevision });
      setDeleteOpen(false);
      toast.success(t("toastDeleted"));
      await navigate({ to: "/admin/discounts", ignoreBlocker: true });
    } catch (error) {
      setDeleteOpen(false);
      showConflict(error);
    }
  }

  const otherClasses = combinableClasses(draft);
  const displayRecord = discount ? { ...discount, status: savedStatus } : null;

  return (
    <form
      data-presence-root={key ?? undefined}
      method="post"
      noValidate
      className="mx-auto max-w-5xl pb-8"
      onSubmit={(event) => {
        event.preventDefault();
        // React bubbles submits from portalled dialogs; only this form saves the page.
        if (event.target === event.currentTarget && scope?.dirty && !scope.busy) void scope.saveAll();
      }}
    >
      <PageHeader
        presence={<PresenceSlot presenceKey={key} revision={savedRevision} dirty={dirty} readOnly={!canSave} />}
        backTo="/admin/discounts"
        title={discount ? heading || t(`type_${view.type}`) : t("newTitle")}
        status={displayRecord ? <DiscountStatusBadge discount={displayRecord} /> : null}
        // An ended discount can't go live: extend its end date instead.
        actions={displayRecord && canToggle && savedStatus !== "archived" && discountStatus(displayRecord) !== "expired" ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || dirty}
            onClick={() => void setActive(savedStatus !== "active")}
          >
            {t(savedStatus === "active" ? "deactivate" : "activate")}
          </Button>
        ) : null}
      />

      {/* A flex gap, so the banner's hidden placeholder adds no space. */}
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {conflict ? (
          <div>
            <Button type="button" variant="outline" onClick={() => void loadTheirs()}>{t("loadTheirs")}</Button>
          </div>
        ) : null}
        {!canSave ? <ReadOnlyNotice /> : null}

        {canSave || discount ? <div className="grid items-start gap-4 lg:grid-cols-3">
          {/* Fields stay editable while saving: later edits stay unsaved, and a failed save can focus its field. */}
          {canSave ? <fieldset disabled={activeMutation.isPending || deleteMutation.isPending} className="min-w-0 space-y-4 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>{t(`type_${draft.type}`)}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-1">
                  <span id="discount-method-label" className="text-body font-medium">{t("methodLabel")}</span>
                  <Tabs value={draft.method} onValueChange={(method) => update({ method: method as DiscountDraft["method"] })}>
                    <TabsList aria-labelledby="discount-method-label">
                      <TabsTrigger value="code">{t("methodCodeTab")}</TabsTrigger>
                      <TabsTrigger value="automatic">{t("methodAutomaticTab")}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {draft.method === "code" ? (
                  <Field
                    id="discount-code"
                    label={t("codeLabel")}
                    help={t("codeHelp")}
                    error={codeError}
                    labelAction={(
                      <FieldAction onClick={() => update({ code: generateDiscountCode() })}>{t("generateCode")}</FieldAction>
                    )}
                  >
                    <Input
                      value={draft.code}
                      autoComplete="off"
                      maxLength={50}
                      onChange={(event) => update({ code: event.target.value.toUpperCase() })}
                    />
                  </Field>
                ) : (
                  <Field id="discount-title" label={t("titleLabel")} help={t("titleHelp")} error={shown("title")}>
                    <Input
                      value={draft.title}
                      maxLength={160}
                      onChange={(event) => update({ title: event.target.value })}
                    />
                  </Field>
                )}
              </CardContent>
            </Card>

            {draft.type === "products" || draft.type === "order" ? (
              <Card>
                <CardHeader><CardTitle>{t("valueCard")}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <FieldRow>
                    <Field id="discount-value-kind" label={t("valueKindLabel")}>
                      <SearchableSelect
                        value={draft.valueKind}
                        onValueChange={(valueKind) => update({ valueKind: valueKind as DiscountDraft["valueKind"] })}
                        triggerClassName="w-full"
                        options={[{ value: "percentage", label: t("percentage") }, { value: "fixed", label: t("fixedAmount") }]}
                      />
                    </Field>
                    <Field
                      id="discount-value"
                      label={t("valueLabel")}
                      error={shown("value")}
                      help={aboveEveryPrice ? <span className="text-warning">{t("warnAboveEveryPrice")}</span> : undefined}
                    >
                      <NumberInput
                        prefix={draft.valueKind === "percentage" ? undefined : symbol}
                        suffix={draft.valueKind === "percentage" ? "%" : undefined}
                        value={draft.value}
                        onValue={(value) => update({ value })}
                      />
                    </Field>
                  </FieldRow>
                  {draft.type === "products" ? (
                    <>
                      {draft.valueKind === "fixed" ? (
                        <CheckRow
                          id="discount-once"
                          label={t("oncePerOrder")}
                          checked={draft.oncePerOrder}
                          onChange={(oncePerOrder) => update({ oncePerOrder })}
                        />
                      ) : null}
                      <FieldSet label={t("appliesTo")}>
                        <ScopeField
                          scope={draft.appliesTo}
                          disabled={!canSave}
                          error={shown("appliesTo")}
                          onChange={(appliesTo) => update({ appliesTo })}
                        />
                      </FieldSet>
                    </>
                  ) : null}
                  <CheckRow
                    id="free-shipping-too"
                    label={t("freeShippingToo")}
                    checked={draft.freeShipping}
                    onChange={(freeShipping) => update({ freeShipping })}
                  />
                  {draft.freeShipping
                    ? numberField("free-shipping-minimum", "freeShippingMinimum", t("freeShippingMinimum"), { money: true, help: t("freeShippingMinimumHelp") })
                    : null}
                  {draft.freeShipping
                    ? numberField("free-shipping-max-rate", "freeShippingMaxRate", t("freeShippingMaxRate"), { money: true, help: t("freeShippingMaxRateHelp") })
                    : null}
                </CardContent>
              </Card>
            ) : null}

            {draft.type === "shipping" ? (
              <Card>
                <CardHeader><CardTitle>{t("shippingCard")}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  {numberField("free-shipping-max-rate", "freeShippingMaxRate", t("freeShippingMaxRate"), { money: true, help: t("freeShippingMaxRateHelp") })}
                </CardContent>
              </Card>
            ) : null}

            {draft.type === "buy_get" ? (
              <>
                <Card>
                  <CardHeader><CardTitle>{t("buysCard")}</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <RadioGroup value={draft.buyKind} onValueChange={(buyKind) => update({ buyKind: buyKind as DiscountDraft["buyKind"], buyValue: "" })}>
                      <RadioRow value="quantity" id="buy-quantity" label={t("buyQuantity")} />
                      <RadioRow value="amount" id="buy-amount" label={t("buyAmount")} />
                    </RadioGroup>
                    {numberField("buy-value", "buyValue", t(draft.buyKind === "quantity" ? "quantity" : "amount"), { whole: draft.buyKind === "quantity", money: draft.buyKind === "amount" })}
                    <FieldSet label={t("anyItemsFrom")}>
                      <ScopeField scope={draft.buyScope} disabled={!canSave} error={shown("buyScope")} onChange={(buyScope) => update({ buyScope })} />
                    </FieldSet>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>{t("getsCard")}</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-body text-muted-foreground">{t("getsHelp")}</p>
                    {numberField("get-quantity", "getQuantity", t("quantity"), { whole: true })}
                    <FieldSet label={t("anyItemsFrom")}>
                      <ScopeField scope={draft.getScope} disabled={!canSave} error={shown("getScope")} onChange={(getScope) => update({ getScope })} />
                    </FieldSet>
                    <FieldSet label={t("discountedValue")}>
                      <RadioGroup value={draft.getValueKind} onValueChange={(getValueKind) => update({ getValueKind: getValueKind as DiscountDraft["getValueKind"] })}>
                        <RadioRow value="percentage" id="get-percentage" label={t("percentage")} />
                        <RadioRow value="free" id="get-free" label={t("free")} />
                      </RadioGroup>
                      </FieldSet>
                      {draft.getValueKind === "percentage" ? numberField("get-value", "getValue", t("valueLabel"), { percent: true }) : null}
                    <CheckRow
                      id="uses-per-order"
                      label={t("limitUsesPerOrder")}
                      checked={draft.limitUsesPerOrder}
                      onChange={(limitUsesPerOrder) => update({ limitUsesPerOrder })}
                    />
                    {draft.limitUsesPerOrder ? numberField("uses-per-order-value", "usesPerOrder", t("quantity"), { whole: true }) : null}
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card>
                <CardHeader><CardTitle>{t("minimumCard")}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <RadioGroup value={draft.minimum} onValueChange={(minimum) => update({ minimum: minimum as DiscountDraft["minimum"], minimumValue: "" })}>
                    <RadioRow value="none" id="minimum-none" label={t("noMinimum")} />
                    <RadioRow value="amount" id="minimum-amount" label={t("minimumAmount")} />
                    <RadioRow value="quantity" id="minimum-quantity" label={t("minimumQuantity")} />
                  </RadioGroup>
                  {draft.minimum !== "none" ? numberField("minimum-value", "minimumValue", t(draft.minimum === "amount" ? "amount" : "quantity"), {
                    whole: draft.minimum === "quantity",
                    money: draft.minimum === "amount",
                    help: draft.type === "products" ? t("minimumScopeHelp") : undefined,
                  }) : null}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader><CardTitle>{t("eligibilityCard")}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <RadioGroup
                  value={draft.eligibility}
                  onValueChange={(eligibility) => update({ eligibility: eligibility as DiscountDraft["eligibility"] })}
                >
                  <RadioRow value="all" id="eligibility-all" label={t("eligibilityAll")} />
                  <RadioRow value="segments" id="eligibility-segments" label={t("eligibilitySegments")} />
                </RadioGroup>
                {draft.eligibility === "segments" ? (
                  <SegmentField
                    ids={draft.customerSegmentIds}
                    disabled={!canSave}
                    error={shown("customerSegmentIds")}
                    onChange={(customerSegmentIds) => update({ customerSegmentIds })}
                  />
                ) : null}
              </CardContent>
            </Card>

            {draft.method === "code" ? (
              <Card>
                <CardHeader><CardTitle>{t("usesCard")}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <CheckRow id="limit-total" label={t("limitTotal")} checked={draft.limitTotal} onChange={(limitTotal) => update({ limitTotal })} />
                  {draft.limitTotal ? numberField("total-uses", "totalUses", t("quantity"), { whole: true }) : null}
                  <CheckRow id="once-per-customer" label={t("oncePerCustomer")} checked={draft.oncePerCustomer} onChange={(oncePerCustomer) => update({ oncePerCustomer })} />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader><CardTitle>{t("combinationsCard")}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-body text-muted-foreground">{t("combinationsHelp")}</p>
                {otherClasses.map((item) => (
                  <CheckRow
                    key={item}
                    id={`combine-${item}`}
                    label={t(`combine_${item}`)}
                    checked={draft.combines[item]}
                    onChange={(checked) => update({ combines: { ...draft.combines, [item]: checked } })}
                  />
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>{t("datesCard")}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <FieldRow>
                  <Field id="start-date" label={t("startDate")} error={shown("startDate")}>
                    <DateInput
                      value={draft.startDate}
                      onValueChange={(startDate) => update({ startDate })}
                    />
                  </Field>
                  <Field id="start-time" label={t("startTime")}>
                    <Input type="time" value={draft.startTime} onChange={(event) => update({ startTime: event.target.value })} />
                  </Field>
                </FieldRow>
                <CheckRow id="set-end" label={t("setEndDate")} checked={draft.hasEnd} onChange={(hasEnd) => update({ hasEnd })} />
                {draft.hasEnd ? (
                  <FieldRow>
                    <Field id="end-date" label={t("endDate")} error={shown("endDate")}>
                      <DateInput
                        value={draft.endDate}
                        onValueChange={(endDate) => update({ endDate })}
                      />
                    </Field>
                    <Field id="end-time" label={t("endTime")}>
                      <Input type="time" value={draft.endTime} onChange={(event) => update({ endTime: event.target.value })} />
                    </Field>
                  </FieldRow>
                ) : null}
              </CardContent>
            </Card>
          </fieldset> : <DiscountSavedView draft={view} format={format} redemptionCount={discount?.redemptionCount ?? 0} />}

          {/* eslint-disable-next-line no-restricted-syntax -- a side column of bordered cards, not a bar */}
          <aside className="space-y-4 lg:sticky lg:top-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("summaryCard")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-heading-sm">{heading || t(view.method === "code" ? "noCodeYet" : "noTitleYet")}</p>
                  <p className="text-body text-muted-foreground">
                    {t(view.method === "code" ? "methodCodeTab" : "methodAutomaticTab")} · {t(`type_${view.type}`)}
                  </p>
                </div>
                <ul className="list-disc space-y-1 ps-5 text-body">
                  {summary.map((line) => <li key={line.key}>{t(line.key, line.vars)}</li>)}
                </ul>
                {preview.length > 0 ? (
                  <div className="space-y-1 border-t pt-3">
                    <p className="text-heading-sm">{t("previewTitle")}</p>
                    <ul className="space-y-1 text-body text-muted-foreground">
                      {preview.slice(0, 5).map(({ name, stacks }) => (
                        <li key={name}>{t(stacks ? "previewStacks" : "previewAlone", { name })}</li>
                      ))}
                      {preview.length > 5 ? <li>{t("previewMore", { count: preview.length - 5 })}</li> : null}
                    </ul>
                  </div>
                ) : null}
                {discount ? (
                  <p className="text-body text-muted-foreground">{t("performance", { count: discount.redemptionCount })}</p>
                ) : null}
              </CardContent>
            </Card>
          </aside>
        </div> : null}
        {/* Save lives in the save bar (P4); deleting stays at the end of the page. */}
        {discount && canDelete ? (
          <div className="flex border-t pt-4">
            <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>{t("delete")}</Button>
          </div>
        ) : null}
      </div>

      {canDelete ? <ConfirmDialog
        open={deleteOpen && Boolean(discount)}
        onOpenChange={setDeleteOpen}
        title={t("deleteTitle", { name: heading || t(`type_${view.type}`) })}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        isLoading={deleteMutation.isPending}
        onConfirm={() => void remove()}
      /> : null}
    </form>
  );
}
