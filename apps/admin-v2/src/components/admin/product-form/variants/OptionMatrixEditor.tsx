import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@scalius/shared/utils";
import { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";
import {
  putApiV1AdminProductsByIdOptionsMatrix,
  putApiV1AdminProductsByIdVariantsByVariantId,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { readApiFieldIssues } from "@/lib/api-field-errors";
import { readProductRevisionConflict, type ProductRevisionConflict } from "@/lib/admin-api-error";
import { queryKeys } from "@/lib/query-keys";
import { SaveNotCompleted } from "../../shared/SaveBar";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { readSkuTaken } from "../hooks/useProductSubmit";
import { formatNumber, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type {
  ProductSkuImageChoice,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "~/lib/api-query-options/products";
import {
  ADVANCED_FIELDS,
  draftId,
  getOptionMatrixIssue,
  getSimpleSkuIssue,
  initialOptions,
  initialVariants,
  combinationKey,
  materializeCombination,
  materializeVariants,
  materializeVariantsExcluding,
  matrixSaveVariants,
  missingOptionCombinations,
  normalized,
  followProductDefaults,
  withGuessedOptionType,
  optionTopologySignature,
  type DraftIssue,
  type DraftIssueField,
  type DraftOption,
  type DraftVariant,
  type OptionMatrixEditorHandle,
  type ProductCreateComposition,
  type ProductFulfilmentMode,
  type SimpleSkuDraft,
  type VariantPriceRange,
  withFulfilmentMode,
} from "./option-matrix-editor-model";
import { barcodePatch, Field, InventoryQuantityInput, type IssueFor } from "./variant-fields";
import { VariantTable } from "./VariantTable";

const MAX_AXES = MAX_PRODUCT_OPTION_AXES;
const MAX_COMBINATIONS = MAX_PRODUCT_OPTION_COMBINATIONS;

/** Request body field → the editor field that shows it. */
const SERVER_FIELDS: Record<string, DraftIssueField> = {
  sku: "sku",
  price: "price",
  stock: "stock",
  expectedStockVersion: "stock",
  barcode: "barcode",
  barcodeType: "barcode",
  weight: "weight",
  discountType: "discount",
  discountPercentage: "discount",
  discountAmount: "discount",
  imageId: "photo",
};


type OptionMatrixEditorProps = {
  productId?: string;
  productName: string;
  productPrice: number;
  /** Active products need every variant priced above 0. */
  requirePositivePrice?: boolean;
  options?: ProductOptionDefinition[];
  variants?: ProductVariant[];
  images: ProductSkuImageChoice[];
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onSaved?: () => void;
  onDraftChange?: (composition: ProductCreateComposition | null) => void;
  /** The draft's problem as one banner line ("M / White: …"), or null. */
  onDraftIssueChange?: (issue: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** The variants' price range while the product has options (they carry the prices), else null. */
  onPricesChange?: (range: VariantPriceRange | null) => void;
  onSavingChange?: (saving: boolean) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  /** The product's Fulfilment select: one kind for every SKU, or per variant (a column). */
  fulfilmentMode?: ProductFulfilmentMode;
};

export const OptionMatrixEditor = React.forwardRef<OptionMatrixEditorHandle, OptionMatrixEditorProps>(function OptionMatrixEditor({
  productId,
  productName,
  productPrice,
  requirePositivePrice = false,
  options: savedOptions = [],
  variants: savedVariants = [],
  images,
  aggregateRevision,
  onAggregateRevisionChange,
  onSaved,
  onDraftChange,
  onDraftIssueChange,
  onDirtyChange,
  onPricesChange,
  onSavingChange,
  onRevisionConflict,
  fulfilmentMode = "physical",
}, ref) {
  const t = useMessages(productMessages);
  const queryClient = useQueryClient();
  const defaultSku = savedVariants.find((variant) => variant.isDefault && !variant.deletedAt);
  const [simpleSku, setSimpleSku] = React.useState<SimpleSkuDraft>(() => ({
    sku: defaultSku?.sku ?? "",
    // New products track quantity by default; saved SKUs keep their setting.
    trackInventory: defaultSku ? defaultSku.trackInventory ?? false : true,
    stock: defaultSku?.stock ?? 0,
    barcode: defaultSku?.barcode ?? null,
    barcodeType: (defaultSku?.barcodeType as SimpleSkuDraft["barcodeType"]) ?? null,
    weight: defaultSku?.weight ?? null,
  }));
  const [simpleStockEdited, setSimpleStockEdited] = React.useState(false);
  const [options, setOptions] = React.useState<DraftOption[]>(() => initialOptions(savedOptions));
  const [variants, setVariants] = React.useState<DraftVariant[]>(() => initialVariants(savedVariants));
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const [revealNonce, setRevealNonce] = React.useState(0);
  const [serverIssue, setServerIssue] = React.useState<DraftIssue | null>(null);
  const [combinationsPending, setCombinationsPending] = React.useState(false);
  const [topologyChanged, setTopologyChanged] = React.useState(false);
  const [excludedCombinationKeys, setExcludedCombinationKeys] = React.useState<Set<string>>(() => new Set(
    missingOptionCombinations(initialOptions(savedOptions), initialVariants(savedVariants)).map(combinationKey),
  ));
  const [omittedVariantsByKey, setOmittedVariantsByKey] = React.useState<Map<string, DraftVariant>>(() => new Map());
  const savedOptionDraft = React.useMemo(() => initialOptions(savedOptions), [savedOptions]);
  const savedTopology = React.useMemo(() => optionTopologySignature(savedOptionDraft), [savedOptionDraft]);
  // Stock that must reach the new rows (the server's rule): a simple product's stock when
  // options are first added, or the stock of saved variants an option change replaces.
  // Variants that are only removed keep their stock on record (see the removal dialog).
  const liveIds = new Set(variants.map((variant) => variant.id));
  const replacedVariants = topologyChanged && variants.some((variant) => variant.id.startsWith("draft_"))
    ? savedVariants.filter((variant) => !variant.isDefault && !variant.deletedAt && !liveIds.has(variant.id))
    : [];
  const simpleConversion = savedOptions.length === 0 && Boolean(defaultSku?.trackInventory);
  const requiredStockAllocation = simpleConversion
    ? defaultSku!.stock
    : replacedVariants.reduce((total, variant) => total + (variant.trackInventory ? variant.stock : 0), 0);
  const blockedCommittedStock = savedOptions.length === 0 ? defaultSku?.reservedStock ?? 0 : 0;
  const committedByVariantId = React.useMemo(
    () => new Map(savedVariants.map((variant) => [variant.id, variant.reservedStock])),
    [savedVariants],
  );
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  const nameOf = (variant: DraftVariant) => variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ");

  const combinationCount = options.length
    ? options.reduce((total, option) => total * option.values.length, 1)
    : 0;
  const validShape = options.length > 0 && options.every((option) => option.name.trim() && option.values.length > 0);
  const matrixIssue = getOptionMatrixIssue(options, variants, images, combinationsPending, {
    committedByVariantId,
    requiredStockAllocation,
    allocationScope: simpleConversion ? "all" : "new",
    blockedCommittedStock,
    allowSavedImageRemovalConfirmation: !dirty,
    requirePositivePrice,
  });
  // A product without options sells one hidden SKU; edit its inventory directly.
  const simpleMode = options.length === 0 && savedOptions.length === 0 && (!productId || Boolean(defaultSku));
  const simpleCommitted = defaultSku?.reservedStock ?? 0;
  const draftIssue = !simpleMode
    ? matrixIssue
    : dirty || !productId ? getSimpleSkuIssue(simpleSku, simpleCommitted, Boolean(productId)) : null;
  const lineFor = (issue: DraftIssue) => {
    const variant = issue.variantId ? variants.find((row) => row.id === issue.variantId) : undefined;
    return variant ? `${nameOf(variant)}: ${issue.message}` : simpleMode && issue.field ? `${t("inventory")}: ${issue.message}` : issue.message;
  };
  const draftLine = draftIssue ? lineFor(draftIssue) : null;
  // Problems show at their field once the merchant changed something, or after Save was refused.
  const shownIssue = serverIssue ?? (dirty || revealed ? draftIssue : null);
  const issueFor: IssueFor = (variantId, field) =>
    shownIssue && shownIssue.field === field && shownIssue.variantId === variantId ? shownIssue.message : undefined;

  React.useEffect(() => {
    if (!onDraftChange) return;
    const sku = simpleSku.sku.trim();
    onDraftChange(draftIssue
      ? null
      : simpleMode
        ? {
            defaultSku: {
              ...(sku ? { sku } : {}),
              trackInventory: simpleSku.trackInventory,
              stock: simpleSku.trackInventory ? simpleSku.stock : 0,
              ...(simpleSku.barcode ? { barcode: simpleSku.barcode, barcodeType: simpleSku.barcodeType } : {}),
              ...(simpleSku.weight !== null ? { weight: simpleSku.weight } : {}),
            },
          }
        : options.length > 0 ? { optionMatrix: { options, variants: withFulfilmentMode(variants, fulfilmentMode) } } : null);
  }, [draftIssue, fulfilmentMode, onDraftChange, options, simpleMode, simpleSku, variants]);

  React.useEffect(() => onDraftIssueChange?.(draftLine), [draftLine, onDraftIssueChange]);
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const prices = options.length > 0 ? variants.map((variant) => variant.price).filter(Number.isFinite) : [];
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
  React.useEffect(
    () => onPricesChange?.(minPrice === null || maxPrice === null ? null : { min: minPrice, max: maxPrice }),
    [minPrice, maxPrice, onPricesChange],
  );

  const reveal = React.useCallback(() => {
    setRevealed(true);
    setRevealNonce((value) => value + 1);
    const target = serverIssue ?? draftIssue;
    if (target?.variantId && target.field && ADVANCED_FIELDS.has(target.field)) setExpandedId(target.variantId);
  }, [draftIssue, serverIssue]);

  // Removing saved variants that still hold stock is confirmed first, naming them.
  const [pendingRemoval, setPendingRemoval] = React.useState<{ title: string; stocked: DraftVariant[]; apply: () => void } | null>(null);
  const confirmRemoval = (title: string, removed: DraftVariant[], apply: () => void) => {
    const stocked = removed.filter((variant) => !variant.id.startsWith("draft_") && variant.trackInventory && variant.stock > 0);
    if (stocked.length === 0) apply();
    else setPendingRemoval({ title, stocked, apply });
  };

  const stageOptions = React.useCallback((nextOptions: DraftOption[]) => {
    setOptions(nextOptions);
    setCombinationsPending(true);
    setDirty(true);
  }, []);

  const applyOptions = React.useCallback(() => {
    if (!validShape || combinationCount > MAX_COMBINATIONS) return;
    const next = materializeVariantsExcluding(
      options,
      variants,
      productName,
      productPrice,
      simpleConversion ? defaultSku!.stock : 0,
      excludedCombinationKeys,
    );
    setVariants(next);
    setExcludedCombinationKeys(new Set(missingOptionCombinations(options, next).map(combinationKey)));
    setTopologyChanged(optionTopologySignature(options) !== savedTopology);
    setCombinationsPending(false);
    setDirty(true);
  }, [combinationCount, defaultSku, excludedCombinationKeys, options, productName, productPrice, savedTopology, simpleConversion, validShape, variants]);

  // Variants follow the options as soon as every option has a name and a value.
  // Existing rows are matched by option values and keep their data; rows that
  // drop out are retired on save, never deleted.
  React.useEffect(() => {
    if (combinationsPending && validShape && combinationCount <= MAX_COMBINATIONS) applyOptions();
  }, [applyOptions, combinationCount, combinationsPending, validShape]);

  // Unsaved variants follow the title and price until the merchant edits them.
  const productDefaults = React.useRef({ name: productName, price: productPrice });
  React.useEffect(() => {
    const previous = productDefaults.current;
    if (previous.name === productName && previous.price === productPrice) return;
    productDefaults.current = { name: productName, price: productPrice };
    setVariants((current) => followProductDefaults(options, current, previous, { name: productName, price: productPrice }));
  }, [options, productName, productPrice]);

  // One pass for one row or many (bulk and group edits); untouched rows keep their identity,
  // so only the edited rows of the table re-render.
  const updateVariants = React.useCallback((
    ids: ReadonlySet<string>,
    patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>),
  ) => {
    setVariants((current) => current.map((variant) => ids.has(variant.id)
      ? { ...variant, ...(typeof patch === "function" ? patch(variant) : patch) }
      : variant));
    setServerIssue((current) => (current?.variantId && ids.has(current.variantId) ? null : current));
    setDirty(true);
  }, []);
  // The page rebuilds the photo list on every render; keep one identity while it is the same.
  const imagesKey = images.map((image) => `${image.id}:${image.url}:${image.status}:${image.altText}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableImages = React.useMemo(() => images, [imagesKey]);

  const updateSimple = (patch: Partial<SimpleSkuDraft>) => {
    setSimpleSku((current) => ({ ...current, ...patch }));
    setServerIssue(null);
    setDirty(true);
  };

  const removeVariants = React.useCallback((ids: ReadonlySet<string>) => {
    if (ids.size === 0 || ids.size >= variants.length) return;
    const removed = variants.filter((variant) => ids.has(variant.id));
    setVariants(variants.filter((variant) => !ids.has(variant.id)));
    setOmittedVariantsByKey((current) => {
      const next = new Map(current);
      removed.forEach((variant) => next.set(combinationKey(variant.selectedOptionValueIds), variant));
      return next;
    });
    setExcludedCombinationKeys((keys) => new Set([
      ...keys,
      ...removed.map((variant) => combinationKey(variant.selectedOptionValueIds)),
    ]));
    setExpandedId((current) => current && ids.has(current) ? null : current);
    setDirty(true);
  }, [variants]);

  const restoreCombination = React.useCallback((selectedOptionValueIds: string[]) => {
    const key = combinationKey(selectedOptionValueIds);
    const restored = omittedVariantsByKey.get(key)
      ?? materializeCombination(options, variants, selectedOptionValueIds, productName, productPrice);
    const next = [...variants, restored];
    const order = new Map(materializeVariants(options, next, productName, productPrice, 0)
      .map((variant, index) => [combinationKey(variant.selectedOptionValueIds), index]));
    setVariants(next.sort((a, b) =>
      (order.get(combinationKey(a.selectedOptionValueIds)) ?? 0)
      - (order.get(combinationKey(b.selectedOptionValueIds)) ?? 0),
    ));
    setExcludedCombinationKeys((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    setOmittedVariantsByKey((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    setDirty(true);
  }, [omittedVariantsByKey, options, productName, productPrice, variants]);

  const restoreAllCombinations = React.useCallback(() => {
    const currentCombinationKeys = new Set(missingOptionCombinations(options, variants).map(combinationKey));
    const restorableOriginals = [...omittedVariantsByKey]
      .filter(([key]) => currentCombinationKeys.has(key))
      .map(([, variant]) => variant);
    setVariants(materializeVariants(options, [...variants, ...restorableOriginals], productName, productPrice, 0));
    setExcludedCombinationKeys(new Set());
    setOmittedVariantsByKey(new Map());
    setDirty(true);
  }, [omittedVariantsByKey, options, productName, productPrice, variants]);

  const missingCombinations = React.useMemo(
    () => missingOptionCombinations(options, variants),
    [options, variants],
  );

  const mutation = useMutation({
    mutationFn: (revisionOverride?: number) => simpleMode && defaultSku
      ? apiData(putApiV1AdminProductsByIdVariantsByVariantId({
          path: { id: productId!, variantId: defaultSku.id },
          body: {
            selectedOptionValueIds: [],
            imageId: defaultSku.imageId,
            weight: simpleSku.weight,
            sku: simpleSku.sku.trim(),
            price: productPrice,
            trackInventory: simpleSku.trackInventory,
            barcode: simpleSku.barcode,
            barcodeType: simpleSku.barcodeType,
            // Unedited quantity is omitted so a concurrent sale is never overwritten.
            ...(simpleStockEdited && simpleSku.trackInventory
              ? { stock: simpleSku.stock, expectedStockVersion: defaultSku.stockVersion }
              : {}),
            discountType: "percentage",
            discountPercentage: null,
            discountAmount: null,
            expectedAggregateRevision: revisionOverride ?? aggregateRevision!,
          },
        }))
      : apiData(putApiV1AdminProductsByIdOptionsMatrix({
          path: { id: productId! },
          body: {
            options,
            variants: matrixSaveVariants(variants, savedVariants, fulfilmentMode),
            expectedAggregateRevision: revisionOverride ?? aggregateRevision!,
          },
        })),
    onSuccess: async (result) => {
      onAggregateRevisionChange?.(result.aggregateRevision);
      setDirty(false);
      setRevealed(false);
      setCombinationsPending(false);
      setTopologyChanged(false);
      setOmittedVariantsByKey(new Map());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.products.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.byIds() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.products.collectionOptions(),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.products.detail(productId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.products.variants(productId!),
        }),
      ]);
      onSaved?.();
    },
  });

  /** Puts a server rejection on its field; returns the banner line, or null when it names no field. */
  const showServerIssue = React.useCallback((path: string, message: string): string | null => {
    const parts = path.split(".");
    const rowIndex = parts.findIndex((part) => part === "variants");
    const field = SERVER_FIELDS[parts[parts.length - 1]!];
    if (!field) return null;
    if (rowIndex >= 0) {
      const variant = variants[Number(parts[rowIndex + 1])];
      if (!variant) return null;
      setServerIssue({ message, variantId: variant.id, field });
      if (ADVANCED_FIELDS.has(field)) setExpandedId(variant.id);
      setRevealNonce((value) => value + 1);
      return `${nameOf(variant)}: ${message}`;
    }
    setServerIssue({ message, field });
    return `${t("inventory")}: ${message}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, t]);

  React.useEffect(() => onSavingChange?.(mutation.isPending), [mutation.isPending, onSavingChange]);
  React.useImperativeHandle(ref, () => ({
    save: async (revisionOverride) => {
      if (!productId || !dirty || mutation.isPending) return;
      if (draftIssue) {
        reveal();
        throw new SaveNotCompleted(lineFor(draftIssue));
      }
      try {
        await mutation.mutateAsync(revisionOverride);
      } catch (error) {
        const conflict = readProductRevisionConflict(error);
        if (conflict) {
          onRevisionConflict?.(conflict);
          throw new SaveNotCompleted(t("changedElsewhere"));
        }
        const issue = readSkuTaken(error) ?? readApiFieldIssues(error)?.[0];
        const line = issue ? showServerIssue(issue.path, issue.message) : null;
        throw new SaveNotCompleted(line ?? getServerFnError(error, t("saveFailed")));
      }
    },
    reveal,
    showServerIssue,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [dirty, draftIssue, mutation, productId, reveal, showServerIssue]);

  return (
    <section data-option-matrix data-variant-editor tabIndex={-1} className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {simpleMode ? (
        <div className="space-y-3">
          <h3 className="text-body font-medium">{t("inventory")}</h3>
          <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
            <Checkbox
              checked={simpleSku.trackInventory}
              onCheckedChange={(checked) => updateSimple({ trackInventory: checked === true })}
            />
            {t("trackQuantity")}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {simpleSku.trackInventory ? (
              <Field label={t("quantity")} error={issueFor(undefined, "stock")}>
                {(invalid) => (
                  <InventoryQuantityInput
                    ariaLabel={t("quantity")}
                    invalid={invalid}
                    value={simpleSku.stock}
                    committed={simpleCommitted}
                    onChange={(stock) => {
                      updateSimple({ stock });
                      setSimpleStockEdited(true);
                    }}
                  />
                )}
              </Field>
            ) : null}
            <Field label={t("sku")} error={issueFor(undefined, "sku")}>
              {(invalid) => (
                <Input
                  value={simpleSku.sku}
                  aria-invalid={invalid}
                  placeholder={productId ? undefined : t("skuAuto")}
                  onChange={(event) => updateSimple({ sku: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("barcode")} help={productId ? undefined : t("barcodeHint")} error={issueFor(undefined, "barcode")}>
              {(invalid) => (
                <Input
                  value={simpleSku.barcode ?? ""}
                  aria-invalid={invalid}
                  inputMode="text"
                  autoComplete="off"
                  onChange={(event) => updateSimple(barcodePatch(event.target.value))}
                />
              )}
            </Field>
            {/* A service is never packed or weighed. */}
            {fulfilmentMode === "service" ? null : (
              <Field label={t("weightGrams")} error={issueFor(undefined, "weight")}>
                {(invalid) => (
                  <NumberInput
                    value={simpleSku.weight}
                    aria-invalid={invalid}
                    onValueChange={(weight) => updateSimple({ weight })}
                  />
                )}
              </Field>
            )}
          </div>
        </div>
      ) : null}

      <div>
        {options.length ? (
          <div className="divide-y border-b">
            {options.map((option, optionIndex) => (
              <OptionRow
                key={option.id}
                option={option}
                index={optionIndex}
                canMoveUp={optionIndex > 0}
                canMoveDown={optionIndex < options.length - 1}
                onMove={(direction) => {
                  const next = [...options];
                  const target = optionIndex + direction;
                  [next[optionIndex], next[target]] = [next[target]!, next[optionIndex]!];
                  stageOptions(next);
                }}
                onChange={(next) => stageOptions(options.map((item) =>
                  item.id === option.id ? withGuessedOptionType(item, next, options) : item))}
                onRemove={() => stageOptions(options.filter((item) => item.id !== option.id))}
                onRemoveValue={(value) => confirmRemoval(
                  t("removeValueTitle", { value: value.value }),
                  variants.filter((variant) => variant.selectedOptionValueIds.includes(value.id)),
                  () => stageOptions(options.map((item) =>
                    item.id === option.id ? { ...item, values: item.values.filter((entry) => entry.id !== value.id) } : item)),
                )}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3 text-body">
          {options.length < MAX_AXES ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => stageOptions([...options, {
                id: draftId("option"),
                name: "",
                standardMapping: "none",
                values: [],
              }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> {t(options.length ? "addAnotherOption" : "addOptions")}
            </Button>
          ) : null}
          {/* Limits show as the merchant nears them (from three quarters), never only at save. */}
          {validShape && combinationCount > MAX_COMBINATIONS * 0.75 ? (
            <span className={cn("tabular-nums", combinationCount > MAX_COMBINATIONS ? "text-destructive" : "text-muted-foreground")}>
              {t("variantsLimitNear", { count: formatNumber(combinationCount), max: formatNumber(MAX_COMBINATIONS) })}
            </span>
          ) : null}
          {options.length >= MAX_AXES ? (
            <span className="text-muted-foreground">{t("optionsAtLimit", { max: formatNumber(MAX_AXES) })}</span>
          ) : null}
        </div>
      </div>

      {/* Option-level problems show once a value is entered (an option still being filled in waits
          for Save); variant problems sit on their field. */}
      {shownIssue && !shownIssue.field && !simpleMode && (!shownIssue.incomplete || revealed)
        && options.some((option) => option.values.length > 0) ? (
        <p className="text-body text-destructive" role="alert">
          {lineFor(shownIssue)}
        </p>
      ) : null}
      {variants.length ? (
        <VariantTable
          options={options}
          variants={variants}
          images={stableImages}
          productName={productName}
          nameOf={nameOf}
          issue={shownIssue}
          reveal={shownIssue?.variantId ? { variantId: shownIssue.variantId, nonce: revealNonce } : null}
          expandedId={expandedId}
          onExpandedChange={setExpandedId}
          onChangeMany={updateVariants}
          onRemove={(ids) => confirmRemoval(
            t("stopSellingTitle", { count: ids.size }),
            variants.filter((variant) => ids.has(variant.id)),
            () => removeVariants(ids),
          )}
          missingCombinations={missingCombinations}
          onRestoreCombination={restoreCombination}
          onRestoreAll={restoreAllCombinations}
          committedByVariantId={committedByVariantId}
          printingDisabled={!productId || dirty}
          fulfilmentColumn={fulfilmentMode === "mixed"}
        />
      ) : options.length > 0 && !combinationsPending ? (
        <p className="text-body text-muted-foreground">{t("addOptionValues")}</p>
      ) : null}
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}
        title={pendingRemoval?.title ?? ""}
        description={pendingRemoval ? t("removeStockedBody", {
          variants: pendingRemoval.stocked.map((variant) => `${nameOf(variant)} (${formatNumber(variant.stock)})`).join(", "),
          count: formatNumber(pendingRemoval.stocked.reduce((total, variant) => total + variant.stock, 0)),
        }) : ""}
        confirmLabel={t("removeAnyway")}
        cancelLabel={t("keepThem")}
        onConfirm={() => {
          pendingRemoval?.apply();
          setPendingRemoval(null);
        }}
      />
    </section>
  );
});

OptionMatrixEditor.displayName = "OptionMatrixEditor";

function OptionRow({ option, index, canMoveUp, canMoveDown, onMove, onChange, onRemove, onRemoveValue }: {
  option: DraftOption;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onChange: (option: DraftOption) => void;
  onRemove: () => void;
  onRemoveValue: (value: DraftOption["values"][number]) => void;
}) {
  const t = useMessages(productMessages);
  const [valueInput, setValueInput] = React.useState("");
  const [duplicate, setDuplicate] = React.useState<string | null>(null);
  const optionLabel = option.name.trim() || t("optionNumber", { number: index + 1 });
  const composerId = React.useId();
  const addValues = () => {
    const existing = new Set(option.values.map((value) => normalized(value.value)));
    const repeated: string[] = [];
    const nextValues = valueInput.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      .flatMap((value) => {
        const identity = normalized(value);
        if (existing.has(identity)) {
          repeated.push(option.values.find((entry) => normalized(entry.value) === identity)?.value ?? value);
          return [];
        }
        existing.add(identity);
        return [{ id: draftId("value"), value }];
      });
    // A value already in the option stays in the box with a reason, never silently dropped.
    setDuplicate(repeated[0] ?? null);
    if (nextValues.length) onChange({ ...option, values: [...option.values, ...nextValues] });
    setValueInput(repeated.join(", "));
  };

  // Shopify's option editor: the name (with how customers filter it) on one line, its values below.
  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-body text-muted-foreground">
          {t("optionNameLabel")}
          <Input
            value={option.name}
            onChange={(event) => onChange({ ...option, name: event.target.value })}
            placeholder={t("optionNamePlaceholder")}
            aria-label={t("optionName", { number: index + 1 })}
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-body text-muted-foreground sm:w-40">
          {t("optionFilterAs")}
          <NativeSelect
            value={option.standardMapping}
            onValueChange={(value) => onChange({ ...option, standardMapping: value as ProductOptionStandardMapping })}
            aria-label={t("optionType", { name: optionLabel })}
          >
            <option value="none">{t("optionTypeOther")}</option>
            <option value="size">{t("optionTypeSize")}</option>
            <option value="color">{t("optionTypeColor")}</option>
            <option value="material">{t("optionTypeMaterial")}</option>
            <option value="pattern">{t("optionTypePattern")}</option>
          </NativeSelect>
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon" disabled={!canMoveUp} onClick={() => onMove(-1)}>
            <ArrowUp className="h-4 w-4" /><span className="sr-only">{t("moveOptionUp")}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!canMoveDown} onClick={() => onMove(1)}>
            <ArrowDown className="h-4 w-4" /><span className="sr-only">{t("moveOptionDown")}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onRemove}>
            <Trash2 className="h-4 w-4" /><span className="sr-only">{t("removeOption")}</span>
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <span className="block text-body text-muted-foreground">{t("optionValuesLabel")}</span>
        {option.values.length ? (
          <div className="flex flex-wrap gap-1">
            {option.values.map((value) => (
              <Badge key={value.id} variant="secondary">
                {value.value}
                <button
                  type="button"
                  aria-label={t("removeValue", { value: value.value })}
                  onClick={() => onRemoveValue(value)}
                  className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Badge>
            ))}
          </div>
        ) : null}
        <Input
          data-option-value-composer
          value={valueInput}
          aria-invalid={Boolean(duplicate)}
          aria-describedby={duplicate ? `${composerId}-duplicate` : undefined}
          onChange={(event) => {
            setValueInput(event.target.value);
            setDuplicate(null);
          }}
          onBlur={addValues}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addValues();
            }
          }}
          placeholder={t(option.values.length ? "addValue" : "addValuesHint")}
          aria-label={t("addValueFor", { name: optionLabel })}
        />
        {duplicate ? (
          <p id={`${composerId}-duplicate`} className="text-body text-destructive">{t("valueDuplicate", { value: duplicate })}</p>
        ) : null}
      </div>
    </div>
  );
}

