import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useForm } from "react-hook-form";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Tag,
} from "lucide-react";

import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  readDiscountRevisionConflict,
  type DiscountRevisionConflict,
} from "~/lib/admin-api-error";
import { useCreateDiscount, useUpdateDiscount } from "~/lib/api-mutations/discounts";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../ui/form";
import { Input } from "../../ui/input";
import { RadioGroup, RadioGroupItem } from "../../ui/radio-group";
import { Switch } from "../../ui/switch";
import { CollectionSelector, type DiscountCollectionOption } from "./CollectionSelector";
import { ProductSelector, type DiscountProductOption } from "./ProductSelector";
import {
  buildDiscountRequirementSummary,
  buildDiscountRuleSummary,
  createDiscountEditorDefaults,
  discountEditorSchema,
  fromDateInputValue,
  getDiscountTypeLabel,
  hydrateSelectedOptionLabels,
  needsDiscountWriteNormalization,
  parseOptionalNumber,
  toDateInputValue,
  toDiscountWritePayload,
  type DiscountEditorDefaults,
  type DiscountEditorType,
  type DiscountEditorValues,
} from "./discount-editor-model";
import { generateDiscountCode } from "./utils";
import {
  normalizeDiscountEndDate,
  normalizeDiscountStartDate,
} from "./shared-validation";

interface DiscountCodeBuilderProps {
  type: DiscountEditorType;
  discountId?: string;
  discountRevision?: number;
  defaultValues?: DiscountEditorDefaults;
  initialSelectedProducts?: DiscountProductOption[];
  initialSelectedCollections?: DiscountCollectionOption[];
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((id, index) => id === normalizedRight[index]);
}

function lifecycleLabel(values: DiscountEditorValues): string {
  const startTime = normalizeDiscountStartDate(values.startDate).getTime();
  const endTime = values.endDate
    ? normalizeDiscountEndDate(values.endDate).getTime()
    : null;
  if (!Number.isFinite(startTime) || (endTime !== null && !Number.isFinite(endTime))) {
    return "Needs attention";
  }
  if (!values.isActive) return "Draft";
  const now = Date.now();
  if (endTime !== null && endTime < now) {
    return "Expired";
  }
  if (startTime > now) return "Scheduled";
  return "Active";
}

function OptionalNumberField({
  field,
  label,
  description,
  prefix,
  integer = false,
}: {
  field: {
    value: number | null;
    onChange: (value: number | null) => void;
    onBlur: () => void;
    name: string;
    ref: Ref<HTMLInputElement>;
  };
  label: string;
  description: string;
  prefix?: string;
  integer?: boolean;
}) {
  return (
    <FormItem>
      <FormLabel>{label}</FormLabel>
      <FormControl>
        <div className="relative">
          {prefix ? (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              {prefix}
            </span>
          ) : null}
          <Input
            ref={field.ref}
            name={field.name}
            type="number"
            inputMode={integer ? "numeric" : "decimal"}
            min={integer ? 1 : 0.01}
            step={integer ? 1 : 0.01}
            value={field.value ?? ""}
            onBlur={field.onBlur}
            onChange={(event) =>
              field.onChange(parseOptionalNumber(event.target.value, integer))
            }
            placeholder="No minimum"
            className={prefix ? "pl-8" : undefined}
          />
        </div>
      </FormControl>
      <FormDescription>{description}</FormDescription>
      <FormMessage />
    </FormItem>
  );
}

export function DiscountCodeBuilder({
  type,
  discountId,
  discountRevision,
  defaultValues,
  initialSelectedProducts = [],
  initialSelectedCollections = [],
}: DiscountCodeBuilderProps) {
  const navigate = useNavigate();
  const { symbol } = useCurrency();
  const { hasPermission } = usePermissions();
  const canToggleStatus = hasPermission(ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS);
  const createMutation = useCreateDiscount();
  const updateMutation = useUpdateDiscount();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] =
    useState<DiscountRevisionConflict | null>(null);
  const [selectedProducts, setSelectedProducts] = useState(initialSelectedProducts);
  const [selectedCollections, setSelectedCollections] = useState(initialSelectedCollections);
  const initialProductsRef = useRef(initialSelectedProducts);
  const initialCollectionsRef = useRef(initialSelectedCollections);
  const initialValues = useMemo(
    () =>
      createDiscountEditorDefaults(type, {
        ...defaultValues,
        appliesToProducts:
          defaultValues?.appliesToProducts ?? initialSelectedProducts.map((item) => item.id),
        appliesToCollections:
          defaultValues?.appliesToCollections ??
          initialSelectedCollections.map((item) => item.id),
      }),
    // The route keys this builder by type. Initial values are intentionally a
    // one-time draft baseline, not a query-refresh overwrite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const requiresNormalization = useMemo(
    () => Boolean(discountId && defaultValues && needsDiscountWriteNormalization(type, defaultValues)),
    // Like initialValues, this is the loaded revision's immutable baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const form = useForm<DiscountEditorValues>({
    resolver: zodResolver(discountEditorSchema),
    defaultValues: initialValues,
  });

  useEffect(() => {
    initialProductsRef.current = hydrateSelectedOptionLabels(
      initialProductsRef.current,
      initialSelectedProducts,
    );
    setSelectedProducts((current) =>
      hydrateSelectedOptionLabels(current, initialSelectedProducts),
    );
  }, [initialSelectedProducts]);

  useEffect(() => {
    initialCollectionsRef.current = hydrateSelectedOptionLabels(
      initialCollectionsRef.current,
      initialSelectedCollections,
    );
    setSelectedCollections((current) =>
      hydrateSelectedOptionLabels(current, initialSelectedCollections),
    );
  }, [initialSelectedCollections]);

  const isSubmitting = createMutation.isPending || updateMutation.isPending;
  const values = form.watch();
  const validation = discountEditorSchema.safeParse(values);
  const readinessIssues = validation.success
    ? []
    : Array.from(new Set(validation.error.issues.map((issue) => issue.message)));
  const hasPendingChanges = form.formState.isDirty || requiresNormalization;

  const handleProductsChange = useCallback(
    (next: DiscountProductOption[]) => {
      setSelectedProducts(next);
      const nextIds = next.map((item) => item.id);
      const currentIds = form.getValues("appliesTo.products");
      if (!sameIds(nextIds, currentIds)) {
        form.setValue("appliesTo.products", nextIds, {
          shouldDirty: true,
          shouldTouch: true,
          shouldValidate: true,
        });
      }
    },
    [form],
  );

  const handleCollectionsChange = useCallback(
    (next: DiscountCollectionOption[]) => {
      setSelectedCollections(next);
      const nextIds = next.map((item) => item.id);
      const currentIds = form.getValues("appliesTo.collections");
      if (!sameIds(nextIds, currentIds)) {
        form.setValue("appliesTo.collections", nextIds, {
          shouldDirty: true,
          shouldTouch: true,
          shouldValidate: true,
        });
      }
    },
    [form],
  );

  function discardChanges() {
    form.reset(initialValues);
    setSelectedProducts(initialProductsRef.current);
    setSelectedCollections(initialCollectionsRef.current);
    setSaveError(null);
  }

  async function save(valuesToSave: DiscountEditorValues) {
    setSaveError(null);
    try {
      const payload = toDiscountWritePayload(valuesToSave);
      if (discountId) {
        if (!discountRevision || discountRevision < 1) {
          setSaveError("The discount version is missing. Reload the latest rule before saving.");
          return;
        }
        await updateMutation.mutateAsync({
          id: discountId,
          expectedRevision: discountRevision,
          ...payload,
        });
      } else {
        await createMutation.mutateAsync(payload);
      }
      form.reset(valuesToSave);
      void navigate({ to: "/admin/discounts" });
    } catch (error) {
      const conflict = readDiscountRevisionConflict(error);
      if (conflict) {
        setRevisionConflict(conflict);
        return;
      }
      setSaveError(
        error instanceof Error
          ? error.message
          : "The discount could not be saved. Review the rule and try again.",
      );
    }
  }

  function invalidSubmit() {
    setSaveError("Review the highlighted fields before saving this discount.");
  }

  return (
    <Form {...form}>
      <UnsavedChangesGuard
        isDirty={hasPendingChanges}
        isSubmitting={isSubmitting}
      />
      <form
        method="post"
        action="/admin/discounts"
        noValidate
        onSubmit={form.handleSubmit(save, invalidSubmit)}
        className="space-y-4 pb-24"
      >
        <Card className="border bg-card shadow-none">
          <CardContent className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                <Tag className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Method
                </p>
                <p className="text-sm font-semibold">Discount code</p>
              </div>
            </div>
            <div className="min-w-0 border-t pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Customer gets
              </p>
              <p className="text-sm font-semibold">{getDiscountTypeLabel(type)}</p>
            </div>
            <div className="flex items-center gap-2 sm:justify-end">
              <Badge variant="outline">Used alone</Badge>
              <span className="text-xs text-muted-foreground">One code per order</span>
            </div>
          </CardContent>
        </Card>

        {saveError ? (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>Discount not saved</AlertTitle>
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        ) : null}

        {revisionConflict ? (
          <Alert>
            <RefreshCw aria-hidden="true" />
            <AlertTitle>Newer discount version found</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Another session changed this rule. Your input is still here; copy anything you need,
                then reload before editing the latest version.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => window.location.reload()}
              >
                Reload latest
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {requiresNormalization ? (
          <Alert>
            <RefreshCw aria-hidden="true" />
            <AlertTitle>Saved rule needs repair</AlertTitle>
            <AlertDescription>
              This rule contains legacy values checkout no longer accepts. Saving keeps the
              visible offer and cleans the stored rule.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-4">
            <Card className="border bg-card shadow-none">
              <CardHeader className="px-4 pb-3 pt-4 sm:px-5">
                <CardTitle className="text-base">Code and value</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 px-4 pb-4 sm:grid-cols-2 sm:px-5">
                <FormField
                  control={form.control}
                  name="code"
                  render={({ field }) => (
                    <FormItem className={type === "free_shipping" ? "sm:col-span-2" : undefined}>
                      <FormLabel>Code</FormLabel>
                      <FormControl>
                        <div className="flex gap-2">
                          <Input
                            {...field}
                            autoComplete="off"
                            maxLength={50}
                            placeholder="WELCOME10"
                            className="min-w-0 font-mono uppercase tracking-wide"
                            onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-10 w-10 shrink-0"
                            aria-label="Generate discount code"
                            title="Generate discount code"
                            onClick={() => field.onChange(generateDiscountCode())}
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </FormControl>
                      <FormDescription>
                        Customers enter this at cart or checkout. Codes are not case-sensitive.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {type !== "free_shipping" ? (
                  <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
                    <FormField
                      control={form.control}
                      name="valueType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Value type</FormLabel>
                          <FormControl>
                            <RadioGroup
                              value={field.value}
                              onValueChange={field.onChange}
                              className="grid grid-cols-2 gap-2"
                            >
                              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[[data-state=checked]]:border-foreground has-[[data-state=checked]]:bg-muted/50">
                                <RadioGroupItem id="discount-value-percentage" value="percentage" />
                                <span>Percentage</span>
                              </label>
                              <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[[data-state=checked]]:border-foreground has-[[data-state=checked]]:bg-muted/50">
                                <RadioGroupItem id="discount-value-fixed" value="fixed_amount" />
                                <span>Fixed amount</span>
                              </label>
                            </RadioGroup>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="discountValue"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Value</FormLabel>
                          <FormControl>
                            <div className="relative">
                              {values.valueType === "fixed_amount" ? (
                                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                  {symbol}
                                </span>
                              ) : null}
                              <Input
                                name={field.name}
                                ref={field.ref}
                                onBlur={field.onBlur}
                                type="number"
                                inputMode="decimal"
                                min="0.01"
                                max={values.valueType === "percentage" ? 100 : undefined}
                                step={values.valueType === "percentage" ? 0.1 : 0.01}
                                value={field.value}
                                onChange={(event) => field.onChange(Number(event.target.value))}
                                className={values.valueType === "fixed_amount" ? "pl-8 pr-8" : "pr-8"}
                              />
                              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                                {values.valueType === "percentage" ? "%" : "off"}
                              </span>
                            </div>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                ) : (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:col-span-2">
                    This code removes the eligible delivery charge. It does not reduce merchandise prices.
                  </div>
                )}
              </CardContent>
            </Card>

            {type === "amount_off_products" ? (
              <Card className="border bg-card shadow-none">
                <CardHeader className="px-4 pb-3 pt-4 sm:px-5">
                  <CardTitle className="text-base">Applies to</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 px-4 pb-4 sm:px-5">
                  <p className="text-sm text-muted-foreground">
                    A matching product needs only one selected product or collection rule.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ProductSelector
                      selectedProducts={selectedProducts}
                      onChange={handleProductsChange}
                      buttonLabel="Choose products"
                      maxItems={90}
                    />
                    <CollectionSelector
                      selectedCollections={selectedCollections}
                      onChange={handleCollectionsChange}
                      buttonLabel="Choose collections"
                      maxItems={90}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="appliesTo"
                    render={() => <FormMessage />}
                  />
                </CardContent>
              </Card>
            ) : null}

            <Card className="border bg-card shadow-none">
              <CardContent className="px-4 py-0 sm:px-5">
                <Accordion
                  type="multiple"
                  defaultValue={[
                    ...(initialValues.minPurchaseAmount || initialValues.minQuantity
                      ? ["requirements"]
                      : []),
                    ...(initialValues.maxUses || initialValues.limitOnePerCustomer || initialValues.endDate
                      ? ["schedule"]
                      : []),
                  ]}
                >
                  <AccordionItem value="requirements">
                    <AccordionTrigger className="min-h-14 py-3 text-left hover:no-underline">
                      <span>
                        <span className="block text-sm font-semibold">Purchase requirements</span>
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {buildDiscountRequirementSummary(values, symbol)}
                        </span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="minPurchaseAmount"
                          render={({ field }) => (
                            <OptionalNumberField
                              field={field}
                              label="Minimum merchandise amount"
                              prefix={symbol}
                              description={
                                type === "amount_off_products"
                                  ? "Counts only merchandise eligible for this product discount."
                                  : "Counts the merchandise subtotal before delivery."
                              }
                            />
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="minQuantity"
                          render={({ field }) => (
                            <OptionalNumberField
                              field={field}
                              label="Minimum item quantity"
                              integer
                              description={
                                type === "amount_off_products"
                                  ? "Counts only eligible item quantities."
                                  : "Counts all item quantities in the cart."
                              }
                            />
                          )}
                        />
                      </div>
                      <p className="mt-3 text-xs text-muted-foreground">
                        When both minimums are set, the cart must meet both.
                      </p>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="schedule" className="border-b-0">
                    <AccordionTrigger className="min-h-14 py-3 text-left hover:no-underline">
                      <span>
                        <span className="block text-sm font-semibold">Schedule and usage</span>
                        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                          {values.endDate ? "Has an end date" : "No end date"}
                          {values.maxUses ? ` · ${values.maxUses} total uses` : " · Unlimited uses"}
                        </span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pb-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="startDate"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Start date</FormLabel>
                              <FormControl>
                                <Input
                                  ref={field.ref}
                                  name={field.name}
                                  onBlur={field.onBlur}
                                  type="date"
                                  value={toDateInputValue(field.value)}
                                  onChange={(event) =>
                                    field.onChange(
                                      fromDateInputValue(event.target.value) ??
                                        new Date(Number.NaN),
                                    )
                                  }
                                />
                              </FormControl>
                              <FormDescription>Starts at 12:00 AM in the merchant’s local time.</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="endDate"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>End date</FormLabel>
                              <FormControl>
                                <Input
                                  ref={field.ref}
                                  name={field.name}
                                  onBlur={field.onBlur}
                                  type="date"
                                  min={toDateInputValue(values.startDate)}
                                  value={toDateInputValue(field.value)}
                                  onChange={(event) =>
                                    field.onChange(fromDateInputValue(event.target.value))
                                  }
                                />
                              </FormControl>
                              <FormDescription>Optional. The selected end date is included.</FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="maxUses"
                          render={({ field }) => (
                            <OptionalNumberField
                              field={field}
                              label="Total usage limit"
                              integer
                              description="Leave blank for no store-wide redemption limit."
                            />
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="limitOnePerCustomer"
                          render={({ field }) => (
                            <FormItem className="flex min-h-20 items-start gap-3 rounded-md border p-3">
                              <FormControl>
                                <Checkbox
                                  id="limit-one-per-customer"
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <div className="space-y-1">
                                <FormLabel htmlFor="limit-one-per-customer" className="cursor-pointer">
                                  One use per customer
                                </FormLabel>
                                <FormDescription>
                                  Uses the checkout phone identity, including guest checkout.
                                </FormDescription>
                              </div>
                            </FormItem>
                          )}
                        />
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>
          </div>

          <aside className="space-y-3 xl:sticky xl:top-4">
            <Card className="border bg-card shadow-none">
              <CardHeader className="px-4 pb-2 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">Rule summary</CardTitle>
                  <Badge variant="outline">{lifecycleLabel(values)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 px-4 pb-4">
                <p className="text-sm font-medium leading-6">
                  {buildDiscountRuleSummary(values, symbol)}
                </p>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t pt-3 text-xs">
                  <dt className="text-muted-foreground">Method</dt>
                  <dd className="font-medium">Code</dd>
                  <dt className="text-muted-foreground">Combines with</dt>
                  <dd className="font-medium">No other codes</dd>
                  <dt className="text-muted-foreground">Purchase minimums</dt>
                  <dd className="max-w-48 text-right font-medium">
                    {buildDiscountRequirementSummary(values, symbol)}
                  </dd>
                  <dt className="text-muted-foreground">Customer limit</dt>
                  <dd className="text-right font-medium">
                    {values.limitOnePerCustomer ? "Once" : "No per-customer limit"}
                  </dd>
                </dl>
                <div className="border-t pt-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {readinessIssues.length === 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />
                    )}
                    {readinessIssues.length === 0
                      ? requiresNormalization
                        ? "Repair ready to save"
                        : "Ready to save"
                      : "Needs attention"}
                  </div>
                  {readinessIssues.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {readinessIssues.slice(0, 4).map((issue) => (
                        <li key={issue} className="flex gap-1.5">
                          <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                          <span>{issue}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-3 py-2 shadow-[0_-4px_16px_-12px_hsl(var(--foreground))] backdrop-blur supports-[padding:max(0px)]:pb-[max(0.5rem,env(safe-area-inset-bottom))] md:left-[var(--sidebar-width,0px)]">
          <div className="mx-auto flex max-w-[118rem] flex-wrap items-center justify-between gap-2">
            <div className="flex min-h-10 items-center gap-3">
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Switch
                        id="discount-active"
                        checked={field.value}
                        disabled={!canToggleStatus}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel htmlFor="discount-active" className="cursor-pointer text-sm">
                      {discountId ? "Discount active" : "Activate after saving"}
                    </FormLabel>
                  </FormItem>
                )}
              />
              {hasPendingChanges ? (
                <span className="hidden text-xs text-muted-foreground sm:inline">Unsaved changes</span>
              ) : null}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {form.formState.isDirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={discardChanges}
                  disabled={isSubmitting}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigate({ to: "/admin/discounts" })}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  isSubmitting ||
                  revisionConflict !== null ||
                  !hasPendingChanges
                }
              >
                {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {discountId ? "Save changes" : "Create discount"}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Form>
  );
}
