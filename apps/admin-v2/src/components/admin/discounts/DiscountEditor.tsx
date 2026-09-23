import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { DiscountStatusBadge } from "./DiscountStatusBadge";
import {
  combinableClasses,
  combinationPreview,
  draftFromDiscount,
  draftToInput,
  emptyDraft,
  generateDiscountCode,
  summarizeDraft,
  validateDraft,
  type DiscountDraft,
  type DiscountType,
} from "./discount-form";
import { ScopeField } from "./ScopeField";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { discountsMessages, type DiscountMessageKey } from "~/i18n/discounts";
import { readPromotionRevisionConflict } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { discountQueryOptions, discountsQueryOptions, type DiscountRecord } from "~/lib/api-query-options/discounts";
import {
  useCreateDiscount,
  useDeleteDiscount,
  useSetDiscountActive,
  useUpdateDiscount,
} from "~/lib/api-mutations/discounts";

function Field({
  id,
  label,
  help,
  error,
  action,
  children,
}: {
  id: string;
  label: string;
  help?: string;
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
      ) : help ? (
        <p id={`${id}-help`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
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

/**
 * Shopify-style discount editor for all four types: one column of cards,
 * a live summary beside it, and one Save button.
 */
export function DiscountEditor({ type, discount }: { type: DiscountType; discount?: DiscountRecord }) {
  const t = useMessages(discountsMessages);
  const { symbol, code: currencyCode } = useCurrency();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const [showErrors, setShowErrors] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const createMutation = useCreateDiscount();
  const updateMutation = useUpdateDiscount();
  const activeMutation = useSetDiscountActive();
  const deleteMutation = useDeleteDiscount();

  const canSave = hasPermission(discount ? ADMIN_PERMISSIONS.DISCOUNTS_EDIT : ADMIN_PERMISSIONS.DISCOUNTS_CREATE);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const canDelete = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_DELETE);
  const errors = validateDraft(draft, currencyCode);
  const shown = (field: keyof DiscountDraft) => (showErrors && errors[field] ? t(errors[field]!) : undefined);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const saving = createMutation.isPending || updateMutation.isPending;
  const busy = saving || activeMutation.isPending || deleteMutation.isPending;
  const money = (value: string) => `${symbol}${value}`;
  const summary = summarizeDraft(draft, {
    money,
    date: (epoch) => formatDateTime(new Date(epoch * 1_000), { dateStyle: "medium", timeStyle: "short" }),
  });
  const heading = draft.method === "code" ? draft.code.trim().toUpperCase() : draft.title.trim();
  const { data: allDiscounts = [] } = useQuery(discountsQueryOptions());
  const preview = combinationPreview(draft, allDiscounts, discount?.id);

  function update(patch: Partial<DiscountDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function handleError(error: unknown) {
    if (readPromotionRevisionConflict(error)) setConflict(true);
  }

  async function save() {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) {
      // Take the merchant to the first field that needs attention.
      requestAnimationFrame(() => {
        const field = document.querySelector<HTMLElement>("[aria-invalid='true']");
        field?.scrollIntoView({ block: "center" });
        field?.focus();
      });
      return;
    }
    if (!canSave) return;
    const input = draftToInput(draft, currencyCode);
    try {
      if (!discount) {
        const created = await createMutation.mutateAsync({ input, activate: canToggle });
        setLeaving(true);
        await navigate({ to: "/admin/discounts/$discountId", params: { discountId: created.id }, replace: true });
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
      handleError(error);
    }
  }

  async function loadTheirs() {
    if (!discount) return;
    const latest = await queryClient.fetchQuery({ ...discountQueryOptions(discount.id), staleTime: 0 });
    const next = draftFromDiscount(latest, currencyCode);
    setDraft(next);
    setBaseline(next);
    setRevision(latest.revision);
    setStatus(latest.status);
    setConflict(false);
  }

  async function setActive(active: boolean) {
    if (!discount || revision === null) return;
    try {
      const result = await activeMutation.mutateAsync({ id: discount.id, expectedRevision: revision, active });
      setRevision(result.revision);
      setStatus(result.status);
    } catch (error) {
      handleError(error);
    }
  }

  async function remove() {
    if (!discount || revision === null) return;
    try {
      await deleteMutation.mutateAsync({ id: discount.id, expectedRevision: revision });
      setLeaving(true);
      setDeleteOpen(false);
      await navigate({ to: "/admin/discounts" });
    } catch (error) {
      setDeleteOpen(false);
      handleError(error);
    }
  }

  const otherClasses = combinableClasses(draft);
  const displayRecord = discount ? { ...discount, status } : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-8">
      <UnsavedChangesGuard isDirty={dirty && !leaving} isSubmitting={busy || leaving} />
      <header className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link to="/admin/discounts" aria-label={t("back")}><ArrowLeft /></Link>
        </Button>
        <h1 className="min-w-0 flex-1 text-heading-lg">
          {discount ? heading || t(`type_${draft.type}`) : t("newTitle")}
        </h1>
        {displayRecord ? <DiscountStatusBadge discount={displayRecord} /> : null}
        {discount && canToggle && status !== "archived" ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || dirty}
            onClick={() => void setActive(status !== "active")}
          >
            {t(status === "active" ? "deactivate" : "activate")}
          </Button>
        ) : null}
      </header>

      {conflict ? (
        <Alert>
          <AlertTitle>{t("conflictTitle")}</AlertTitle>
          <AlertDescription>
            <Button type="button" variant="link" onClick={() => void loadTheirs()}>{t("loadTheirs")}</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {!canSave ? <p className="text-body text-muted-foreground">{t("readOnly")}</p> : null}

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <fieldset disabled={!canSave || busy} className="min-w-0 space-y-4 lg:col-span-2">
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
                  error={shown("code")}
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
                    aria-invalid={shown("code") ? true : undefined}
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
                <Field id="discount-value" label={`${t("valueLabel")} (${draft.valueKind === "percentage" ? "%" : symbol})`} error={shown("value")}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select value={draft.valueKind} onValueChange={(valueKind) => update({ valueKind: valueKind as DiscountDraft["valueKind"] })}>
                      <SelectTrigger aria-label={t("valueCard")}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">{t("percentage")}</SelectItem>
                        <SelectItem value="fixed">{t("fixedAmount")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      id="discount-value"
                      inputMode="decimal"
                      value={draft.value}
                      aria-invalid={shown("value") ? true : undefined}
                      onChange={(event) => update({ value: event.target.value })}
                    />
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
                {draft.freeShipping ? (
                  <Field
                    id="free-shipping-minimum"
                    label={t("freeShippingMinimum", { symbol })}
                    help={t("freeShippingMinimumHelp")}
                    error={shown("freeShippingMinimum")}
                  >
                    <Input
                      id="free-shipping-minimum"
                      inputMode="decimal"
                      value={draft.freeShippingMinimum}
                      aria-invalid={shown("freeShippingMinimum") ? true : undefined}
                      onChange={(event) => update({ freeShippingMinimum: event.target.value })}
                    />
                  </Field>
                ) : null}
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
                  <Field id="buy-value" label={t(draft.buyKind === "quantity" ? "quantity" : "amount")} error={shown("buyValue")}>
                    <Input
                      id="buy-value"
                      inputMode={draft.buyKind === "quantity" ? "numeric" : "decimal"}
                      value={draft.buyValue}
                      aria-invalid={shown("buyValue") ? true : undefined}
                      onChange={(event) => update({ buyValue: event.target.value })}
                    />
                  </Field>
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
                  <Field id="get-quantity" label={t("quantity")} error={shown("getQuantity")}>
                    <Input
                      id="get-quantity"
                      inputMode="numeric"
                      value={draft.getQuantity}
                      aria-invalid={shown("getQuantity") ? true : undefined}
                      onChange={(event) => update({ getQuantity: event.target.value })}
                    />
                  </Field>
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
                    {draft.getValueKind === "percentage" ? (
                      <Field id="get-value" label={`${t("valueLabel")} (%)`} error={shown("getValue")}>
                        <Input
                          id="get-value"
                          inputMode="decimal"
                          value={draft.getValue}
                          aria-invalid={shown("getValue") ? true : undefined}
                          onChange={(event) => update({ getValue: event.target.value })}
                        />
                      </Field>
                    ) : null}
                  </div>
                  <CheckRow
                    id="uses-per-order"
                    label={t("limitUsesPerOrder")}
                    checked={draft.limitUsesPerOrder}
                    onChange={(limitUsesPerOrder) => update({ limitUsesPerOrder })}
                  />
                  {draft.limitUsesPerOrder ? (
                    <Field id="uses-per-order-value" label={t("quantity")} error={shown("usesPerOrder")}>
                      <Input
                        id="uses-per-order-value"
                        inputMode="numeric"
                        value={draft.usesPerOrder}
                        aria-invalid={shown("usesPerOrder") ? true : undefined}
                        onChange={(event) => update({ usesPerOrder: event.target.value })}
                      />
                    </Field>
                  ) : null}
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
                {draft.minimum !== "none" ? (
                  <Field
                    id="minimum-value"
                    label={t(draft.minimum === "amount" ? "amount" : "quantity")}
                    help={draft.type === "products" ? t("minimumScopeHelp") : undefined}
                    error={shown("minimumValue")}
                  >
                    <Input
                      id="minimum-value"
                      inputMode={draft.minimum === "amount" ? "decimal" : "numeric"}
                      value={draft.minimumValue}
                      aria-invalid={shown("minimumValue") ? true : undefined}
                      onChange={(event) => update({ minimumValue: event.target.value })}
                    />
                  </Field>
                ) : null}
              </CardContent>
            </Card>
          )}

          {draft.method === "code" ? (
            <Card>
              <CardHeader><CardTitle>{t("usesCard")}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <CheckRow id="limit-total" label={t("limitTotal")} checked={draft.limitTotal} onChange={(limitTotal) => update({ limitTotal })} />
                {draft.limitTotal ? (
                  <Field id="total-uses" label={t("quantity")} error={shown("totalUses")}>
                    <Input
                      id="total-uses"
                      inputMode="numeric"
                      value={draft.totalUses}
                      aria-invalid={shown("totalUses") ? true : undefined}
                      onChange={(event) => update({ totalUses: event.target.value })}
                    />
                  </Field>
                ) : null}
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
                  <Input id="start-date" type="date" value={draft.startDate} onChange={(event) => update({ startDate: event.target.value })} />
                </Field>
                <Field id="start-time" label={t("startTime")}>
                  <Input id="start-time" type="time" value={draft.startTime} onChange={(event) => update({ startTime: event.target.value })} />
                </Field>
              </div>
              <CheckRow id="set-end" label={t("setEndDate")} checked={draft.hasEnd} onChange={(hasEnd) => update({ hasEnd })} />
              {draft.hasEnd ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="end-date" label={t("endDate")} error={shown("endDate")}>
                    <Input id="end-date" type="date" value={draft.endDate} onChange={(event) => update({ endDate: event.target.value })} />
                  </Field>
                  <Field id="end-time" label={t("endTime")}>
                    <Input id="end-time" type="time" value={draft.endTime} onChange={(event) => update({ endTime: event.target.value })} />
                  </Field>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {discount && canDelete ? (
              <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>{t("delete")}</Button>
            ) : <span />}
            {canSave ? (
              <Button type="button" disabled={!dirty && Boolean(discount)} loading={saving} onClick={() => void save()}>
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
                {summary.map((line) => <li key={line.key}>{t(line.key as DiscountMessageKey, line.vars)}</li>)}
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
                <p className="text-body text-muted-foreground">{t("performance", { count: formatNumber(discount.redemptionCount) })}</p>
              ) : null}
            </CardContent>
          </Card>
        </aside>
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
    </div>
  );
}
