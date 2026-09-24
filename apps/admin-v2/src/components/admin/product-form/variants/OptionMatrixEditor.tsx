import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ImageIcon,
  Plus,
  Printer,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { detectBarcodeType } from "@scalius/shared/barcode-identity";
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
import { useCurrency } from "@/hooks/use-currency";
import { SaveNotCompleted } from "../../shared/SaveBar";
import { IdText } from "~/components/admin/data-table/cells";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { readSkuTaken } from "../hooks/useProductSubmit";
import { formatNumber, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
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
  type SimpleSkuDraft,
  type VariantPriceRange,
} from "./option-matrix-editor-model";

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

/** The message a field shows, if the current (or server's) problem is about it. */
type IssueFor = (variantId: string | undefined, field: DraftIssueField) => string | undefined;

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
        : options.length > 0 ? { optionMatrix: { options, variants } } : null);
  }, [draftIssue, onDraftChange, options, simpleMode, simpleSku, variants]);

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

  const updateVariant = React.useCallback((id: string, patch: Partial<DraftVariant>) => {
    setVariants((current) => current.map((variant) => variant.id === id ? { ...variant, ...patch } : variant));
    setServerIssue((current) => (current?.variantId === id ? null : current));
    setDirty(true);
  }, []);

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
            variants: matrixSaveVariants(variants, savedVariants),
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
            <Field label={t("weightGrams")} error={issueFor(undefined, "weight")}>
              {(invalid) => (
                <NumberInput
                  value={simpleSku.weight}
                  aria-invalid={invalid}
                  onValueChange={(weight) => updateSimple({ weight })}
                />
              )}
            </Field>
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
          {/* Limits are shown before the merchant reaches them, never only at save. */}
          {options.length ? (
            <span className="text-muted-foreground tabular-nums">
              <span className={cn(combinationCount > MAX_COMBINATIONS && "text-destructive")}>
                {t("combinationSummary", { count: validShape ? combinationCount : variants.length, max: MAX_COMBINATIONS })}
              </span>
              {" · "}
              {t("optionSummary", { count: options.length, max: MAX_AXES })}
            </span>
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
        <VariantMatrix
          options={options}
          variants={variants}
          images={images}
          nameOf={nameOf}
          issueFor={issueFor}
          reveal={shownIssue?.variantId ? { variantId: shownIssue.variantId, nonce: revealNonce } : null}
          expandedId={expandedId}
          onExpandedChange={setExpandedId}
          onChange={updateVariant}
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

/** Typing or scanning a barcode picks its type (EAN-13, UPC, …); clearing it removes both. */
function barcodePatch(value: string): Pick<DraftVariant, "barcode" | "barcodeType"> {
  const barcode = value.trim() ? value : null;
  return { barcode, barcodeType: barcode ? detectBarcodeType(barcode) : null };
}

/** A labelled field with its help and its problem underneath (one error indicator: text + border). */
function Field({ label, help, error, children }: {
  label: string;
  help?: string;
  error?: string;
  children: (invalid: boolean) => React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-body text-muted-foreground">
      {label}
      {children(Boolean(error))}
      {error ? <span className="block text-destructive">{error}</span> : help ? <span className="block">{help}</span> : null}
    </label>
  );
}

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

function VariantMatrix({ options, variants, images, nameOf, issueFor, reveal, expandedId, onExpandedChange, onChange, onRemove, missingCombinations, onRestoreCombination, onRestoreAll, committedByVariantId, printingDisabled }: {
  options: DraftOption[];
  variants: DraftVariant[];
  images: ProductSkuImageChoice[];
  nameOf: (variant: DraftVariant) => string;
  issueFor: IssueFor;
  /** Turn to the page of a variant whose problem was just revealed. */
  reveal: { variantId: string; nonce: number } | null;
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
  onChange: (id: string, patch: Partial<DraftVariant>) => void;
  onRemove: (ids: ReadonlySet<string>) => void;
  missingCombinations: string[][];
  onRestoreCombination: (valueIds: string[]) => void;
  onRestoreAll: () => void;
  committedByVariantId: ReadonlyMap<string, number>;
  printingDisabled: boolean;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const { fmt, salePrice } = useCurrency();
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [bulkPrice, setBulkPrice] = React.useState<number | null>(null);
  const [bulkStock, setBulkStock] = React.useState<number | null>(null);
  const [bulkImageId, setBulkImageId] = React.useState<string | null | undefined>(undefined);
  const filteredVariants = variants.filter((variant) => {
    const needle = normalized(query);
    if (!needle) return true;
    const label = variant.selectedOptionValueIds.map((id) => valueLabel.get(id) ?? "").join(" ");
    return normalized(`${label} ${variant.sku} ${variant.barcode ?? ""}`).includes(needle);
  });
  const pageSize = 30;
  const pageCount = Math.max(1, Math.ceil(filteredVariants.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleVariants = filteredVariants.slice(safePage * pageSize, (safePage + 1) * pageSize);
  React.useEffect(() => setPage(0), [query, variants.length]);
  // A revealed problem may sit on another page or be hidden by the search.
  React.useEffect(() => {
    if (!reveal) return;
    const index = variants.findIndex((variant) => variant.id === reveal.variantId);
    if (index < 0) return;
    setQuery("");
    setPage(Math.floor(index / pageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce]);
  React.useEffect(() => {
    const available = new Set(variants.map((variant) => variant.id));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [variants]);
  const allVisibleSelected = visibleVariants.length > 0 && visibleVariants.every((variant) => selected.has(variant.id));
  const selectedPersistedIds = [...selected].filter((id) => id.startsWith("var_"));
  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const bulkValid = (bulkPrice === null || Number.isFinite(bulkPrice)) && (bulkStock === null || Number.isInteger(bulkStock));
  const applyBulk = () => {
    selected.forEach((id) => onChange(id, {
      ...(bulkPrice !== null ? { price: Math.max(0, bulkPrice) } : {}),
      ...(bulkStock !== null ? { stock: Math.max(0, bulkStock) } : {}),
      ...(bulkImageId !== undefined ? { imageId: bulkImageId } : {}),
    }));
    setBulkPrice(null);
    setBulkStock(null);
    setBulkImageId(undefined);
  };
  const saleOf = (variant: DraftVariant) => (Number.isFinite(variant.price) ? salePrice(variant.price, variant) : null);
  const priceCell = (variant: DraftVariant) => {
    const error = issueFor(variant.id, "price");
    const sale = saleOf(variant);
    return (
      <div className="space-y-1">
        <NumberInput
          value={variant.price}
          aria-invalid={Boolean(error)}
          aria-label={t("priceFor", { name: nameOf(variant) })}
          onValueChange={(price) => onChange(variant.id, { price: price ?? Number.NaN })}
        />
        {error ? <p className="text-body text-destructive">{error}</p> : null}
        {!error && !issueFor(variant.id, "discount") && sale !== null ? (
          <p className="text-right text-body text-muted-foreground tabular-nums">{t("salePrice", { amount: fmt(sale) })}</p>
        ) : null}
      </div>
    );
  };
  const stockCell = (variant: DraftVariant) => {
    const error = issueFor(variant.id, "stock");
    return (
      <div className="space-y-1">
        <InventoryQuantityInput
          ariaLabel={t("quantityFor", { name: nameOf(variant) })}
          invalid={Boolean(error)}
          value={variant.stock}
          committed={committedByVariantId.get(variant.id) ?? 0}
          onChange={(stock) => onChange(variant.id, { stock })}
        />
        {error ? <p className="text-body text-destructive">{error}</p> : null}
      </div>
    );
  };
  const photoPicker = (variant: DraftVariant) => (
    <VariantImagePicker
      value={variant.imageId}
      images={images}
      invalid={Boolean(issueFor(variant.id, "photo"))}
      label={t("photoFor", { name: nameOf(variant) })}
      onChange={(imageId) => onChange(variant.id, { imageId: imageId ?? null })}
    />
  );
  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
        <span className="text-body font-medium">{t("variantCount", { count: variants.length })}</span>
        <div className="flex items-center gap-1.5">
          {missingCombinations.length > 0 ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  {t("notForSaleCount", { count: missingCombinations.length })}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                <div className="flex items-center justify-between gap-2 border-b px-1 pb-2">
                  <p className="text-body text-muted-foreground">{t("notForSaleHint")}</p>
                  <Button type="button" variant="ghost" size="sm" onClick={onRestoreAll}>{t("turnAllOn")}</Button>
                </div>
                <div className="max-h-56 overflow-y-auto pt-1">
                  {missingCombinations.map((valueIds) => {
                    const label = valueIds.map((id) => valueLabel.get(id) ?? "?").join(" / ");
                    return (
                      <button
                        key={combinationKey(valueIds)}
                        type="button"
                        onClick={() => onRestoreCombination(valueIds)}
                        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9"
                      >
                        <span className="truncate">{label}</span>
                        <span className="shrink-0 text-muted-foreground">{t("turnOn")}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          <label className="relative">
            <span className="sr-only">{t("findVariant")}</span>
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("findVariant")} className="w-44" />
          </label>
        </div>
      </div>
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-2 py-2 text-body">
          {/* The count and Clear stay together on the left, so Clear never wraps alone. */}
          <span className="flex items-center gap-1">
            <strong className="font-medium">{r("selected", { count: selected.size })}</strong>
            <Button type="button" variant="link" size="sm" onClick={() => setSelected(new Set())}>{t("clearSelection")}</Button>
          </span>
          <NumberInput value={bulkPrice} onValueChange={setBulkPrice} placeholder={t("price")} aria-label={t("price")} aria-invalid={bulkPrice !== null && !Number.isFinite(bulkPrice)} className="w-24" />
          <NumberInput value={bulkStock} integer onValueChange={setBulkStock} placeholder={t("quantity")} aria-label={t("quantity")} aria-invalid={bulkStock !== null && !Number.isInteger(bulkStock)} className="w-24" />
          <VariantImagePicker
            value={bulkImageId}
            images={images}
            label={t("photoForSelected")}
            allowNoChange
            onChange={setBulkImageId}
          />
          <Button
            type="button"
            size="sm"
            disabled={!bulkValid || (bulkPrice === null && bulkStock === null && bulkImageId === undefined)}
            onClick={applyBulk}
          >
            {t("apply")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selected.size >= variants.length}
            aria-describedby={selected.size >= variants.length ? "variant-bulk-keep-one" : undefined}
            onClick={() => {
              onRemove(selected);
              setSelected(new Set());
            }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> {t("stopSelling")}
          </Button>
          {selectedPersistedIds.length > 0 ? (
            printingDisabled ? (
              <Button type="button" variant="outline" size="sm" disabled>
                <Printer className="mr-1 h-3.5 w-3.5" /> {t("saveBeforePrinting")}
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/inventory/labels" search={{ variants: selectedPersistedIds.join(",") }}>
                  <Printer className="mr-1 h-3.5 w-3.5" /> {t("printLabels")}
                </Link>
              </Button>
            )
          ) : null}
          {/* Visible on touch and to keyboard users, not only as a hover title. */}
          {selected.size >= variants.length ? (
            <p id="variant-bulk-keep-one" className="w-full text-body text-muted-foreground">{t("keepOneVariant")}</p>
          ) : null}
        </div>
      ) : null}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-body">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="w-10 p-2 text-center">
                <Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    visibleVariants.forEach((variant) => checked === true ? next.add(variant.id) : next.delete(variant.id));
                    return next;
                  });
                }} aria-label={r("selectAll")} />
              </th>
              <th className="w-14 p-2"><span className="sr-only">{t("photo")}</span></th>
              <th className="p-2 font-medium">{t("variant")}</th>
              <th className="w-28 p-2 text-right font-medium">{t("price")}</th>
              <th className="w-24 p-2 text-right font-medium">{t("quantity")}</th>
              {/* Two icon buttons (print, stop selling) and nothing more, so the variant column keeps the room. */}
              <th className="w-22 p-2"><span className="sr-only">{r("actions")}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visibleVariants.map((variant) => {
              const expanded = expandedId === variant.id;
              return (
                <React.Fragment key={variant.id}>
                  <tr className="align-top">
                    <td className="p-2 text-center">
                      <Checkbox checked={selected.has(variant.id)} onCheckedChange={(checked) => toggleSelected(variant.id, checked === true)} aria-label={r("select", { name: nameOf(variant) })} />
                    </td>
                    <td className="p-2">{photoPicker(variant)}</td>
                    <td className="p-2">
                      <button type="button" onClick={() => onExpandedChange(expanded ? null : variant.id)} className="flex min-h-10 w-full items-center gap-1.5 rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded}>
                        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0 break-words">{nameOf(variant)}</span>
                      </button>
                      {/* Identifiers never split mid-word: one line, full value on hover and in the copy button. */}
                      <IdText value={variant.sku} copy className="text-muted-foreground" />
                      {issueFor(variant.id, "photo") ? <p className="text-body text-destructive">{issueFor(variant.id, "photo")}</p> : null}
                    </td>
                    <td className="p-2">{priceCell(variant)}</td>
                    <td className="p-2">{stockCell(variant)}</td>
                    <td className="p-2">
                      <div className="flex items-center justify-end">
                      {variant.id.startsWith("var_") && !printingDisabled ? (
                        <Button asChild variant="ghost" size="icon">
                          <Link to="/admin/inventory/labels" search={{ variants: variant.id }} aria-label={t("printLabelFor", { name: nameOf(variant) })}>
                            <Printer className="h-4 w-4" />
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={variants.length === 1}
                        title={variants.length === 1 ? t("keepOneVariant") : undefined}
                        aria-label={t("stopSellingVariant", { name: nameOf(variant) })}
                        onClick={() => onRemove(new Set([variant.id]))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      </div>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td />
                      <td colSpan={5} className="px-2 pb-4">
                        <AdvancedSkuFields variant={variant} name={nameOf(variant)} issueFor={issueFor} onChange={(patch) => onChange(variant.id, patch)} />
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="divide-y md:hidden">
        {visibleVariants.map((variant) => (
          <div key={variant.id} className="space-y-2 py-3">
            <div className="flex items-center gap-2">
              <label className="flex h-11 w-8 shrink-0 items-center justify-center">
                <Checkbox checked={selected.has(variant.id)} onCheckedChange={(checked) => toggleSelected(variant.id, checked === true)} aria-label={r("select", { name: nameOf(variant) })} />
              </label>
              {photoPicker(variant)}
              {/* Names and SKUs wrap: Bangla values run long and the SKU is how staff tell rows apart. */}
              <button
                type="button"
                aria-expanded={expandedId === variant.id}
                aria-label={t("moreFieldsFor", { name: nameOf(variant) })}
                onClick={() => onExpandedChange(expandedId === variant.id ? null : variant.id)}
                className="flex min-h-11 min-w-0 flex-1 items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0", expandedId !== variant.id && "-rotate-90")} />
                <span className="min-w-0">
                  <span className="block break-words font-medium">{nameOf(variant)}</span>
                  <span className="block break-all font-mono text-muted-foreground">{variant.sku}</span>
                </span>
              </button>
              {/* Same order as the desktop table: print, then the destructive action last. */}
              <div className="flex shrink-0 justify-end gap-1">
                {variant.id.startsWith("var_") && !printingDisabled ? (
                  <Button asChild variant="ghost" size="icon">
                    <Link to="/admin/inventory/labels" search={{ variants: variant.id }} aria-label={t("printLabelFor", { name: nameOf(variant) })}>
                      <Printer className="h-4 w-4" />
                    </Link>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={variants.length === 1}
                  title={variants.length === 1 ? t("keepOneVariant") : undefined}
                  aria-label={t("stopSellingVariant", { name: nameOf(variant) })}
                  onClick={() => onRemove(new Set([variant.id]))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1 text-body text-muted-foreground">{t("price")}{priceCell(variant)}</div>
              <div className="space-y-1 text-body text-muted-foreground">{t("quantity")}{stockCell(variant)}</div>
            </div>
            {expandedId === variant.id ? <AdvancedSkuFields variant={variant} name={nameOf(variant)} issueFor={issueFor} onChange={(patch) => onChange(variant.id, patch)} /> : null}
          </div>
        ))}
      </div>
      {filteredVariants.length === 0 ? <div className="px-3 py-6 text-center text-body text-muted-foreground">{r("noResults")}</div> : null}
      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t py-2 text-body text-muted-foreground">
          <span>
            {r("showing", {
              start: safePage * pageSize + 1,
              end: Math.min((safePage + 1) * pageSize, filteredVariants.length),
              total: filteredVariants.length,
            })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>{r("previous")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>{r("next")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InventoryQuantityInput({ value, committed, onChange, ariaLabel, invalid = false }: {
  value: number;
  committed: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const t = useMessages(productMessages);
  const available = Math.max(0, value - committed);
  return (
    <div className="space-y-1">
      <NumberInput
        value={value}
        integer
        aria-invalid={invalid}
        aria-label={ariaLabel ?? t("quantity")}
        // Empty or not a number stays visible as a problem instead of turning into 0.
        onValueChange={(next) => onChange(next ?? Number.NaN)}
      />
      {committed > 0 && Number.isFinite(value) ? (
        <p className="text-right text-body text-muted-foreground tabular-nums" title={t("inOpenOrders", { onHand: value, committed })}>
          {t("availableToSell", { count: available })}
        </p>
      ) : null}
    </div>
  );
}

// Variant photo = an exact product image, or null to use the product's main photo.
function VariantImagePicker({ value, images, onChange, label, allowNoChange = false, invalid = false }: {
  value: string | null | undefined;
  images: ProductSkuImageChoice[];
  onChange: (value: string | null | undefined) => void;
  label?: string;
  allowNoChange?: boolean;
  invalid?: boolean;
}) {
  const t = useMessages(productMessages);
  const selectedIndex = images.findIndex((image) => image.id === value);
  const selected = images[selectedIndex];
  // Every photo is named by its position and description, so similar photos can be told apart.
  const photoName = (index: number) => {
    const image = images[index]!;
    return [
      t("photoNumberOf", { number: index + 1, total: images.length }),
      image.altText || null,
      image.status === "trashed" ? t("mediaInTrash") : null,
    ].filter(Boolean).join(", ");
  };
  const state = value === undefined
    ? t("photoNoChange")
    : value === null || !selected
      ? t("mainPhoto")
      : photoName(selectedIndex);
  const triggerLabel = `${label ?? t("variantPhoto")}: ${state}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="overflow-hidden" aria-label={triggerLabel} aria-invalid={invalid || undefined}>
          {selected
            ? <img
                src={mediaImageUrl(selected.url, 80)}
                alt=""
                className="h-full w-full object-contain object-center"
              />
            : <ImageIcon className="h-4 w-4 text-muted-foreground" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        {allowNoChange ? (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className={cn("mb-1 flex min-h-11 w-full items-center gap-2 rounded p-1.5 text-left text-body hover:bg-muted", value === undefined && "bg-muted")}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded border"><ImageIcon className="h-4 w-4" /></span>
            {t("photoNoChange")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn("mb-1 flex min-h-11 w-full items-center gap-2 rounded p-1.5 text-left text-body hover:bg-muted", value === null && "bg-muted")}
        >
          <span className="flex h-9 w-9 items-center justify-center rounded border">
            <ImageIcon className="h-4 w-4" />
          </span>
          {t("mainPhoto")}
        </button>
        <div className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
          {images.map((image, index) => {
            const unavailable = image.status === "trashed" && value !== image.id;
            return (
              <button
                key={image.id}
                type="button"
                disabled={unavailable}
                onClick={() => onChange(image.id)}
                aria-label={photoName(index)}
                aria-pressed={value === image.id}
                className={cn(
                  "relative aspect-square overflow-hidden rounded border-2",
                  value === image.id ? "border-primary" : "border-transparent",
                  unavailable && "cursor-not-allowed opacity-45",
                )}
                title={photoName(index)}
              >
                <img
                  src={mediaImageUrl(image.url, 96)}
                  alt=""
                  className="h-full w-full object-contain object-center"
                />
                {image.status === "trashed" ? <span className="absolute inset-x-0 bottom-0 truncate bg-foreground py-0.5 text-body text-background">{t("mediaInTrash")}</span> : null}
              </button>
            );
          })}
        </div>
        {images.length === 0 ? (
          <p className="px-1 py-2 text-body text-muted-foreground">{t("addPhotosFirst")}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function DiscountInput({ variant, name, invalid, onChange }: {
  variant: DraftVariant;
  name: string;
  invalid: boolean;
  onChange: (patch: Partial<DraftVariant>) => void;
}) {
  const t = useMessages(productMessages);
  const amount = variant.discountType === "flat" ? variant.discountAmount ?? 0 : variant.discountPercentage ?? 0;
  const [mode, setMode] = React.useState<"none" | "percentage" | "flat">(
    amount > 0 ? variant.discountType : "none",
  );
  return (
    <div className="flex min-w-0 gap-1">
      <NativeSelect
        value={mode}
        onValueChange={(next) => {
          setMode(next as "none" | "percentage" | "flat");
          if (next === "none") {
            onChange({ discountType: "percentage", discountPercentage: null, discountAmount: null });
          } else if (next === "percentage") {
            onChange({ discountType: "percentage", discountPercentage: 0, discountAmount: null });
          } else {
            onChange({ discountType: "flat", discountAmount: 0, discountPercentage: null });
          }
        }}
        aria-label={t("discountTypeFor", { name })}
        className="min-w-24 flex-1"
      >
        <option value="none">{t("noDiscount")}</option>
        <option value="percentage">{t("discountPercentage")}</option>
        <option value="flat">{t("discountFixed")}</option>
      </NativeSelect>
      {mode !== "none" ? (
        <NumberInput
          value={amount}
          aria-invalid={invalid}
          aria-label={t("discountValueFor", { name })}
          onValueChange={(next) => onChange(mode === "flat"
            ? { discountAmount: next ?? 0 }
            : { discountPercentage: next ?? 0 })}
          className="w-20"
        />
      ) : null}
    </div>
  );
}

function AdvancedSkuFields({ variant, name, issueFor, onChange }: {
  variant: DraftVariant;
  name: string;
  issueFor: IssueFor;
  onChange: (patch: Partial<DraftVariant>) => void;
}) {
  const t = useMessages(productMessages);
  const isUnsavedSku = variant.id.startsWith("draft_");
  const errorOf = (field: DraftIssueField) => issueFor(variant.id, field);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t("sku")} error={errorOf("sku")}>
        {(invalid) => (
          <Input value={variant.sku} aria-invalid={invalid} onChange={(event) => onChange({ sku: event.target.value })} aria-label={t("skuFor", { name })} />
        )}
      </Field>
      <Field label={t("discount")} error={errorOf("discount")}>
        {(invalid) => <DiscountInput variant={variant} name={name} invalid={invalid} onChange={onChange} />}
      </Field>
      {/* Scan or type: the type is picked from the code, and can still be changed. */}
      <Field label={t("barcode")} help={isUnsavedSku && !variant.barcode ? t("barcodeHint") : undefined} error={errorOf("barcode")}>
        {(invalid) => (
          <Input
            value={variant.barcode ?? ""}
            aria-invalid={invalid}
            aria-label={t("barcodeFor", { name })}
            autoComplete="off"
            onChange={(event) => onChange(barcodePatch(event.target.value))}
          />
        )}
      </Field>
      <Field label={t("barcodeType")}>
        {() => (
          <NativeSelect
            value={variant.barcodeType ?? "none"}
            onValueChange={(value) => onChange(value === "none"
              ? { barcodeType: null, barcode: null }
              : { barcodeType: value as DraftVariant["barcodeType"] })}
          >
            <option value="none">{t(isUnsavedSku ? "barcodeAuto" : "noBarcode")}</option>
            <option value="ean13">EAN-13</option>
            <option value="upc">UPC</option>
            <option value="isbn">ISBN</option>
            <option value="gtin">GTIN</option>
            <option value="code128">Code 128</option>
            <option value="custom">{t("barcodeCustom")}</option>
          </NativeSelect>
        )}
      </Field>
      <Field label={t("weightGrams")} error={errorOf("weight")}>
        {(invalid) => (
          <NumberInput
            value={variant.weight}
            aria-invalid={invalid}
            aria-label={t("weightFor", { name })}
            onValueChange={(weight) => onChange({ weight })}
          />
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-body md:min-h-8">
        <Switch checked={variant.trackInventory} onCheckedChange={(trackInventory) => onChange({ trackInventory })} />
        {t("trackQuantity")}
      </label>
    </div>
  );
}
