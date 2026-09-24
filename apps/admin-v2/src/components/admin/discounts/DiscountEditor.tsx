import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { getDecimalPlaces } from "@scalius/shared/currency";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import {
  MAX_AMOUNT_MAJOR,
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
  validateDraft,
  type DiscountDraft,
  type DiscountType,
  type Scope,
  type SummaryFormat,
} from "./discount-form";
import { ScopeField, useScopeItems, useScopeLabel } from "./ScopeField";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, SaveErrorBanner, useSaveBar, useSaveScope } from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { NativeSelect } from "~/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { AdminApiResponseError, readPromotionRevisionConflict } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { discountQueryOptions, discountsQueryOptions, type DiscountRecord } from "~/lib/api-query-options/discounts";
import {
  discountFailureText,
  useCreateDiscount,
  useDeleteDiscount,
  useSetDiscountActive,
  useUpdateDiscount,
} from "~/lib/api-mutations/discounts";

function Field({
  id,
  label,
  help,
  warning,
  error,
  action,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  warning?: string;
  error?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {action ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={id}>{label}</Label>
          {action}
        </div>
      ) : <Label htmlFor={id}>{label}</Label>}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-body text-destructive">{error}</p>
      ) : warning ? (
        <p id={`${id}-help`} className="text-body text-warning">{warning}</p>
      ) : help ? (
        <p id={`${id}-help`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

type NumericField = "value" | "freeShippingMinimum" | "minimumValue" | "buyValue" | "getQuantity" | "getValue" | "usesPerOrder" | "totalUses";

/** A number field that takes Bangla digits too (typed ১০ becomes 10). */
function NumberInput({ id, value, error, whole, onValue }: {
  id: string;
  value: string;
  error?: string;
  whole?: boolean;
  onValue: (value: string) => void;
}) {
  return (
    <Input
      id={id}
      inputMode={whole ? "numeric" : "decimal"}
      autoComplete="off"
      value={value}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
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
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-lh items-center">
        <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      </span>
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
}

function RadioRow({ value, id, label }: { value: string; id: string; label: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-lh items-center">
        <RadioGroupItem value={value} id={id} />
      </span>
      <Label htmlFor={id}>{label}</Label>
    </div>
  );
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
  const { symbol, code: currencyCode, fmt } = useCurrency();
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
  const errors = validateDraft(draft, currencyCode);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const busy = Boolean(scope?.busy) || activeMutation.isPending || deleteMutation.isPending;
  const errorVars = {
    places: formatNumber(getDecimalPlaces(currencyCode)),
    max: fmt(MAX_AMOUNT_MAJOR),
    maxQuantity: formatNumber(MAX_QUANTITY),
  };
  // Messages show once Save is pressed; a finished end date is checked as soon as it's picked.
  const shown = (field: keyof DiscountDraft) =>
    errors[field] && (scope?.revealed || (field === "endDate" && draft.endDate)) ? t(errors[field]!, errorVars) : undefined;
  const codeTaken = takenCode !== null && draft.code.trim().toUpperCase() === takenCode;
  const codeError = shown("code") ?? (codeTaken ? t("errorCodeTaken") : undefined);

  const appliesItems = useScopeItems(draft.appliesTo);
  const buyItems = useScopeItems(draft.buyScope);
  const getItems = useScopeItems(draft.getScope);
  const scopeLabel = useScopeLabel();
  const items = new Map([...appliesItems, ...buyItems, ...getItems]);
  const format: SummaryFormat = {
    money: (major) => fmt(Number(major)),
    number: (value) => formatNumber(Number(value)),
    date: (epoch) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium", timeStyle: "short" }),
    scope: (picked: Scope) => scopeLabel(picked, items),
  };
  const { data: allDiscounts = [] } = useQuery(discountsQueryOptions());
  const preview = combinationPreview(draft, allDiscounts, discount?.id);
  const summary = summarizeDraft(draft, currencyCode, format, preview.filter((item) => item.stacks).length);
  // Each product's highest price buyers pay: an amount above all of them makes every item free.
  const prices = draft.appliesTo.ids.map((id) => appliesItems.get(id)?.priceRange?.to);
  const aboveEveryPrice = exceedsEveryPrice(
    draft,
    prices.every((price) => price !== undefined) ? (prices as number[]) : null,
    currencyCode,
  );
  const heading = draft.method === "code" ? draft.code.trim().toUpperCase() : draft.title.trim();
  function update(patch: Partial<DiscountDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const numberField = (
    id: string,
    field: NumericField,
    label: string,
    { whole, help }: { whole?: boolean; help?: string } = {},
  ) => (
    <Field id={id} label={label} help={help} error={shown(field)}>
      <NumberInput id={id} whole={whole} value={draft[field]} error={shown(field)} onValue={(value) => update({ [field]: value })} />
    </Field>
  );

  /** Runs inside the save bar: throws so the bar stays up and the banner explains. */
  async function save() {
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
    const latest = await queryClient.fetchQuery({ ...discountQueryOptions(discount.id), staleTime: 0 });
    const next = draftFromDiscount(latest, currencyCode);
    // Clears the failed-save banner; the draft below replaces the discarded one.
    scope?.discardAll();
    setDraft(next);
    setBaseline(next);
    setRevision(latest.revision);
    setStatus(latest.status);
    setConflict(false);
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
    if (!discount || revision === null) return;
    try {
      const result = await activeMutation.mutateAsync({ id: discount.id, expectedRevision: revision, active });
      setRevision(result.revision);
      setStatus(result.status);
      toast.success(t(active ? "toastActivated" : "toastDeactivated"));
    } catch (error) {
      showConflict(error);
    }
  }

  async function remove() {
    if (!discount || revision === null) return;
    try {
      await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: revision });
      setDeleteOpen(false);
      toast.success(t("toastDeleted"));
      await navigate({ to: "/admin/discounts", ignoreBlocker: true });
    } catch (error) {
      setDeleteOpen(false);
      showConflict(error);
    }
  }

  const otherClasses = combinableClasses(draft);
  const displayRecord = discount ? { ...discount, status } : null;

  return (
    <form
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
        backTo="/admin/discounts"
        title={discount ? heading || t(`type_${draft.type}`) : t("newTitle")}
        badge={displayRecord ? <DiscountStatusBadge discount={displayRecord} /> : null}
        // An ended discount can't go live: extend its end date instead.
        actions={displayRecord && canToggle && status !== "archived" && discountStatus(displayRecord) !== "expired" ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || dirty}
            onClick={() => void setActive(status !== "active")}
          >
            {t(status === "active" ? "deactivate" : "activate")}
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
        {!canSave ? <p className="text-body text-muted-foreground">{t("readOnly")}</p> : null}

        <div className="grid items-start gap-4 lg:grid-cols-3">
          {/* Fields stay editable while saving: later edits stay unsaved, and a failed save can focus its field. */}
          <fieldset disabled={!canSave || activeMutation.isPending || deleteMutation.isPending} className="min-w-0 space-y-4 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>{t(`type_${draft.type}`)}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t("methodLabel")}</Label>
                  <Tabs value={draft.method} onValueChange={(method) => update({ method: method as DiscountDraft["method"] })}>
                    <TabsList>
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
                    action={(
                      <Button type="button" variant="link" size="sm" className="-my-2 -mr-2.5" onClick={() => update({ code: generateDiscountCode() })}>
                        {t("generateCode")}
                      </Button>
                    )}
                  >
                    <Input
                      id="discount-code"
                      value={draft.code}
                      autoComplete="off"
                      maxLength={50}
                      aria-invalid={codeError ? true : undefined}
                      aria-describedby={codeError ? "discount-code-error" : undefined}
                      onChange={(event) => update({ code: event.target.value.toUpperCase() })}
                    />
                  </Field>
                ) : (
                  <Field id="discount-title" label={t("titleLabel")} help={t("titleHelp")} error={shown("title")}>
                    <Input
                      id="discount-title"
                      value={draft.title}
                      maxLength={160}
                      aria-invalid={shown("title") ? true : undefined}
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
                  <Field
                    id="discount-value"
                    label={`${t("valueLabel")} (${draft.valueKind === "percentage" ? "%" : symbol})`}
                    error={shown("value")}
                    warning={aboveEveryPrice ? t("warnAboveEveryPrice") : undefined}
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <NativeSelect
                        value={draft.valueKind}
                        onValueChange={(valueKind) => update({ valueKind: valueKind as DiscountDraft["valueKind"] })}
                        aria-label={t("valueCard")}
                      >
                        <option value="percentage">{t("percentage")}</option>
                        <option value="fixed">{t("fixedAmount")}</option>
                      </NativeSelect>
                      <NumberInput id="discount-value" value={draft.value} error={shown("value")} onValue={(value) => update({ value })} />
                    </div>
                  </Field>
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
                      <div className="space-y-2">
                        <Label>{t("appliesTo")}</Label>
                        <ScopeField
                          scope={draft.appliesTo}
                          disabled={!canSave}
                          error={shown("appliesTo")}
                          onChange={(appliesTo) => update({ appliesTo })}
                        />
                      </div>
                    </>
                  ) : null}
                  <CheckRow
                    id="free-shipping-too"
                    label={t("freeShippingToo")}
                    checked={draft.freeShipping}
                    onChange={(freeShipping) => update({ freeShipping })}
                  />
                  {draft.freeShipping
                    ? numberField("free-shipping-minimum", "freeShippingMinimum", t("freeShippingMinimum", { symbol }), { help: t("freeShippingMinimumHelp") })
                    : null}
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
                    {numberField("buy-value", "buyValue", t(draft.buyKind === "quantity" ? "quantity" : "amount"), { whole: draft.buyKind === "quantity" })}
                    <div className="space-y-2">
                      <Label>{t("anyItemsFrom")}</Label>
                      <ScopeField scope={draft.buyScope} disabled={!canSave} error={shown("buyScope")} onChange={(buyScope) => update({ buyScope })} />
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>{t("getsCard")}</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-body text-muted-foreground">{t("getsHelp")}</p>
                    {numberField("get-quantity", "getQuantity", t("quantity"), { whole: true })}
                    <div className="space-y-2">
                      <Label>{t("anyItemsFrom")}</Label>
                      <ScopeField scope={draft.getScope} disabled={!canSave} error={shown("getScope")} onChange={(getScope) => update({ getScope })} />
                    </div>
                    <div className="space-y-3">
                      <Label>{t("discountedValue")}</Label>
                      <RadioGroup value={draft.getValueKind} onValueChange={(getValueKind) => update({ getValueKind: getValueKind as DiscountDraft["getValueKind"] })}>
                        <RadioRow value="percentage" id="get-percentage" label={t("percentage")} />
                        <RadioRow value="free" id="get-free" label={t("free")} />
                      </RadioGroup>
                      {draft.getValueKind === "percentage" ? numberField("get-value", "getValue", `${t("valueLabel")} (%)`) : null}
                    </div>
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
                    <RadioRow value="amount" id="minimum-amount" label={t("minimumAmount", { symbol })} />
                    <RadioRow value="quantity" id="minimum-quantity" label={t("minimumQuantity")} />
                  </RadioGroup>
                  {draft.minimum !== "none" ? numberField("minimum-value", "minimumValue", t(draft.minimum === "amount" ? "amount" : "quantity"), {
                    whole: draft.minimum === "quantity",
                    help: draft.type === "products" ? t("minimumScopeHelp") : undefined,
                  }) : null}
                </CardContent>
              </Card>
            )}

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
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="start-date" label={t("startDate")} error={shown("startDate")}>
                    <Input
                      id="start-date"
                      type="date"
                      value={draft.startDate}
                      aria-invalid={shown("startDate") ? true : undefined}
                      onChange={(event) => update({ startDate: event.target.value })}
                    />
                  </Field>
                  <Field id="start-time" label={t("startTime")}>
                    <Input id="start-time" type="time" value={draft.startTime} onChange={(event) => update({ startTime: event.target.value })} />
                  </Field>
                </div>
                <CheckRow id="set-end" label={t("setEndDate")} checked={draft.hasEnd} onChange={(hasEnd) => update({ hasEnd })} />
                {draft.hasEnd ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="end-date" label={t("endDate")} error={shown("endDate")}>
                      <Input
                        id="end-date"
                        type="date"
                        value={draft.endDate}
                        aria-invalid={shown("endDate") ? true : undefined}
                        onChange={(event) => update({ endDate: event.target.value })}
                      />
                    </Field>
                    <Field id="end-time" label={t("endTime")}>
                      <Input id="end-time" type="time" value={draft.endTime} onChange={(event) => update({ endTime: event.target.value })} />
                    </Field>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Shopify repeats Save at the end of the page, under a divider. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              {discount && canDelete ? (
                <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>{t("delete")}</Button>
              ) : <span />}
              {canSave ? (
                <Button type="submit" loading={Boolean(scope?.busy)} disabled={!scope?.dirty}>
                  {t("save")}
                </Button>
              ) : null}
            </div>
          </fieldset>

          {/* eslint-disable-next-line no-restricted-syntax -- a side column of bordered cards, not a bar */}
          <aside className="space-y-4 lg:sticky lg:top-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("summaryCard")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-heading-sm">{heading || t(draft.method === "code" ? "noCodeYet" : "noTitleYet")}</p>
                  <p className="text-body text-muted-foreground">
                    {t(draft.method === "code" ? "methodCodeTab" : "methodAutomaticTab")} · {t(`type_${draft.type}`)}
                  </p>
                </div>
                <ul className="list-disc space-y-1 pl-5 text-body">
                  {summary.map((line) => <li key={line.key}>{t(line.key, line.vars)}</li>)}
                </ul>
                {preview.length > 0 ? (
                  <div className="space-y-1 border-t pt-3">
                    <p className="text-heading-sm">{t("previewTitle")}</p>
                    <ul className="space-y-1 text-body text-muted-foreground">
                      {preview.slice(0, 5).map(({ name, stacks }) => (
                        <li key={name}>{t(stacks ? "previewStacks" : "previewAlone", { name })}</li>
                      ))}
                      {preview.length > 5 ? <li>{t("previewMore", { count: formatNumber(preview.length - 5) })}</li> : null}
                    </ul>
                  </div>
                ) : null}
                {discount ? (
                  <p className="text-body text-muted-foreground">{t("performance", { count: formatNumber(discount.redemptionCount) })}</p>
                ) : null}
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen && Boolean(discount)}
        onOpenChange={setDeleteOpen}
        title={t("deleteTitle", { name: heading || t(`type_${draft.type}`) })}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        isLoading={deleteMutation.isPending}
        onConfirm={() => void remove()}
      />
    </form>
  );
}
