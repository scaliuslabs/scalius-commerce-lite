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
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";
import {
  putApiV1AdminProductsByIdOptionsMatrix,
  putApiV1AdminProductsByIdVariantsByVariantId,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { readProductRevisionConflict, type ProductRevisionConflict } from "@/lib/admin-api-error";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type {
  ProductSkuImageChoice,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "~/lib/api-query-options/products";
import {
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
  type DraftOption,
  type DraftVariant,
  type OptionMatrixEditorHandle,
  type ProductCreateComposition,
  type SimpleSkuDraft,
} from "./option-matrix-editor-model";

const MAX_AXES = MAX_PRODUCT_OPTION_AXES;
const MAX_COMBINATIONS = MAX_PRODUCT_OPTION_COMBINATIONS;

type OptionMatrixEditorProps = {
  productId?: string;
  productName: string;
  productPrice: number;
  options?: ProductOptionDefinition[];
  variants?: ProductVariant[];
  images: ProductSkuImageChoice[];
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onSaved?: () => void;
  onDraftChange?: (composition: ProductCreateComposition | null) => void;
  onDraftIssueChange?: (issue: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
};

export const OptionMatrixEditor = React.forwardRef<OptionMatrixEditorHandle, OptionMatrixEditorProps>(function OptionMatrixEditor({
  productId,
  productName,
  productPrice,
  options: savedOptions = [],
  variants: savedVariants = [],
  images,
  aggregateRevision,
  onAggregateRevisionChange,
  onSaved,
  onDraftChange,
  onDraftIssueChange,
  onDirtyChange,
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
  }));
  const [simpleStockEdited, setSimpleStockEdited] = React.useState(false);
  const [options, setOptions] = React.useState<DraftOption[]>(() => initialOptions(savedOptions));
  const [variants, setVariants] = React.useState<DraftVariant[]>(() => initialVariants(savedVariants));
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [combinationsPending, setCombinationsPending] = React.useState(false);
  const [topologyChanged, setTopologyChanged] = React.useState(false);
  const [excludedCombinationKeys, setExcludedCombinationKeys] = React.useState<Set<string>>(() => new Set(
    missingOptionCombinations(initialOptions(savedOptions), initialVariants(savedVariants)).map(combinationKey),
  ));
  const [omittedVariantsByKey, setOmittedVariantsByKey] = React.useState<Map<string, DraftVariant>>(() => new Map());
  const savedOptionDraft = React.useMemo(() => initialOptions(savedOptions), [savedOptions]);
  const savedTopology = React.useMemo(() => optionTopologySignature(savedOptionDraft), [savedOptionDraft]);
  const requiredStockAllocation = savedOptions.length === 0 && defaultSku?.trackInventory
    ? defaultSku.stock
    : topologyChanged
      ? savedVariants.filter((variant) => !variant.isDefault && variant.trackInventory).reduce((total, variant) => total + variant.stock, 0)
      : 0;
  const blockedCommittedStock = savedOptions.length === 0 ? defaultSku?.reservedStock ?? 0 : 0;
  const committedByVariantId = React.useMemo(
    () => new Map(savedVariants.map((variant) => [variant.id, variant.reservedStock])),
    [savedVariants],
  );

  const combinationCount = options.length
    ? options.reduce((total, option) => total * option.values.length, 1)
    : 0;
  const validShape = options.length > 0 && options.every((option) => option.name.trim() && option.values.length > 0);
  const matrixIssue = getOptionMatrixIssue(
    options,
    variants,
    images,
    combinationsPending,
    committedByVariantId,
    requiredStockAllocation,
    blockedCommittedStock,
    !dirty,
  );
  // A product without options sells one hidden SKU; edit its inventory directly.
  const simpleMode = options.length === 0 && savedOptions.length === 0 && (!productId || Boolean(defaultSku));
  const simpleCommitted = defaultSku?.reservedStock ?? 0;
  const draftIssue = !simpleMode
    ? matrixIssue
    : dirty || !productId ? getSimpleSkuIssue(simpleSku, simpleCommitted, Boolean(productId)) : null;

  React.useEffect(() => {
    if (!onDraftChange) return;
    const sku = simpleSku.sku.trim();
    onDraftChange(draftIssue
      ? null
      : simpleMode
        ? { defaultSku: { ...(sku ? { sku } : {}), trackInventory: simpleSku.trackInventory, stock: simpleSku.trackInventory ? simpleSku.stock : 0 } }
        : options.length > 0 ? { optionMatrix: { options, variants } } : null);
  }, [draftIssue, onDraftChange, options, simpleMode, simpleSku, variants]);

  React.useEffect(() => onDraftIssueChange?.(draftIssue), [draftIssue, onDraftIssueChange]);
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

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
      requiredStockAllocation,
      excludedCombinationKeys,
    );
    setVariants(next);
    setExcludedCombinationKeys(new Set(missingOptionCombinations(options, next).map(combinationKey)));
    setTopologyChanged(optionTopologySignature(options) !== savedTopology);
    setCombinationsPending(false);
    setDirty(true);
  }, [combinationCount, excludedCombinationKeys, options, productName, productPrice, requiredStockAllocation, savedTopology, validShape, variants]);

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
    setDirty(true);
  }, []);

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
            weight: defaultSku.weight,
            sku: simpleSku.sku.trim(),
            price: productPrice,
            trackInventory: simpleSku.trackInventory,
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
      toast.success(t(simpleMode ? "inventorySaved" : "variantsSaved"));
      onSaved?.();
    },
    onError: (error) => {
      const conflict = readProductRevisionConflict(error);
      if (conflict) {
        onRevisionConflict?.(conflict);
        return;
      }
      toast.error(getServerFnError(error, t("saveFailed")));
    },
  });

  React.useEffect(() => onSavingChange?.(mutation.isPending), [mutation.isPending, onSavingChange]);
  React.useImperativeHandle(ref, () => ({
    save: (revisionOverride) => {
      if (!productId || !dirty || draftIssue || mutation.isPending) return;
      mutation.mutate(revisionOverride);
    },
  }), [dirty, draftIssue, mutation, productId]);

  return (
    <section data-option-matrix data-variant-editor tabIndex={-1} className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {simpleMode ? (
        <div className="space-y-3">
          <h3 className="text-body font-medium">{t("inventory")}</h3>
          <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
            <Checkbox
              checked={simpleSku.trackInventory}
              onCheckedChange={(checked) => {
                setSimpleSku((current) => ({ ...current, trackInventory: checked === true }));
                setDirty(true);
              }}
            />
            {t("trackQuantity")}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {simpleSku.trackInventory ? (
              <label className="space-y-1 text-body text-muted-foreground">
                {t("quantity")}
                <InventoryQuantityInput
                  ariaLabel={t("quantity")}
                  value={simpleSku.stock}
                  committed={simpleCommitted}
                  onChange={(stock) => {
                    setSimpleSku((current) => ({ ...current, stock }));
                    setSimpleStockEdited(true);
                    setDirty(true);
                  }}
                />
              </label>
            ) : null}
            <label className="space-y-1 text-body text-muted-foreground">
              {t("sku")}
              <Input
                value={simpleSku.sku}
                placeholder={productId ? undefined : t("skuAuto")}
                onChange={(event) => {
                  setSimpleSku((current) => ({ ...current, sku: event.target.value }));
                  setDirty(true);
                }}
              />
            </label>
          </div>
          {draftIssue ? <p className="text-body text-destructive" role="alert">{draftIssue}</p> : null}
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
                {t("combinationSummary", { count: combinationCount, max: MAX_COMBINATIONS })}
              </span>
              {" · "}
              {t("optionSummary", { count: options.length, max: MAX_AXES })}
            </span>
          ) : null}
        </div>
      </div>

      {/* Problems show once the merchant has entered a value; saving explains them too. */}
      {matrixIssue && options.some((option) => option.values.length > 0) ? (
        <p className="text-body text-destructive" role="alert">
          {matrixIssue}
        </p>
      ) : null}
      {variants.length ? (
        <VariantMatrix
          options={options}
          variants={variants}
          images={images}
          expandedId={expandedId}
          onExpandedChange={setExpandedId}
          onChange={updateVariant}
          onRemove={removeVariants}
          missingCombinations={missingCombinations}
          onRestoreCombination={restoreCombination}
          onRestoreAll={restoreAllCombinations}
          committedByVariantId={committedByVariantId}
          printingDisabled={!productId || dirty}
        />
      ) : options.length > 0 && !combinationsPending ? (
        <p className="text-body text-muted-foreground">{t("addOptionValues")}</p>
      ) : null}
    </section>
  );
});

OptionMatrixEditor.displayName = "OptionMatrixEditor";

function OptionRow({ option, index, canMoveUp, canMoveDown, onMove, onChange, onRemove }: {
  option: DraftOption;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onChange: (option: DraftOption) => void;
  onRemove: () => void;
}) {
  const t = useMessages(productMessages);
  const [valueInput, setValueInput] = React.useState("");
  const optionLabel = option.name.trim() || t("optionNumber", { number: index + 1 });
  const addValues = () => {
    const existing = new Set(option.values.map((value) => normalized(value.value)));
    const nextValues = valueInput.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      .flatMap((value) => {
        const identity = normalized(value);
        if (existing.has(identity)) return [];
        existing.add(identity);
        return [{ id: draftId("value"), value }];
      });
    if (!nextValues.length) return;
    onChange({ ...option, values: [...option.values, ...nextValues] });
    setValueInput("");
  };

  return (
    <div className="grid gap-2 py-3 sm:grid-cols-12 sm:items-start">
      <div className="grid grid-cols-3 gap-2 sm:col-span-5">
        <Input
          value={option.name}
          onChange={(event) => onChange({ ...option, name: event.target.value })}
          placeholder={t("optionNamePlaceholder")}
          aria-label={t("optionName", { number: index + 1 })}
          className="col-span-2"
        />
        <Select
          value={option.standardMapping}
          onValueChange={(value) => onChange({ ...option, standardMapping: value as ProductOptionStandardMapping })}
        >
          <SelectTrigger aria-label={t("optionType", { name: optionLabel })} className="min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("optionTypeOther")}</SelectItem>
            <SelectItem value="size">{t("optionTypeSize")}</SelectItem>
            <SelectItem value="color">{t("optionTypeColor")}</SelectItem>
            <SelectItem value="material">{t("optionTypeMaterial")}</SelectItem>
            <SelectItem value="pattern">{t("optionTypePattern")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0 space-y-2 sm:col-span-5">
        {option.values.length ? (
          <div className="flex flex-wrap gap-1">
            {option.values.map((value) => (
              <Badge key={value.id} variant="secondary">
                {value.value}
                <button
                  type="button"
                  aria-label={t("removeValue", { value: value.value })}
                  onClick={() => onChange({ ...option, values: option.values.filter((item) => item.id !== value.id) })}
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
          onChange={(event) => setValueInput(event.target.value)}
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
      </div>
      <div className="flex items-center justify-end gap-0.5 sm:col-span-2">
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
  );
}

function VariantMatrix({ options, variants, images, expandedId, onExpandedChange, onChange, onRemove, missingCombinations, onRestoreCombination, onRestoreAll, committedByVariantId, printingDisabled }: {
  options: DraftOption[];
  variants: DraftVariant[];
  images: ProductSkuImageChoice[];
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
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  const nameOf = (variant: DraftVariant) => variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [bulkPrice, setBulkPrice] = React.useState("");
  const [bulkStock, setBulkStock] = React.useState("");
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
  const applyBulk = () => {
    const price = bulkPrice === "" ? null : Number(bulkPrice);
    const stock = bulkStock === "" ? null : Math.trunc(Number(bulkStock));
    selected.forEach((id) => onChange(id, {
      ...(price !== null && Number.isFinite(price) ? { price: Math.max(0, price) } : {}),
      ...(stock !== null && Number.isFinite(stock) ? { stock: Math.max(0, stock) } : {}),
      ...(bulkImageId !== undefined ? { imageId: bulkImageId } : {}),
    }));
    setBulkPrice("");
    setBulkStock("");
    setBulkImageId(undefined);
  };
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
          <strong>{r("selected", { count: selected.size })}</strong>
          <Input type="number" min={0} value={bulkPrice} onChange={(event) => setBulkPrice(event.target.value)} placeholder={t("price")} aria-label={t("price")} className="w-24" />
          <Input type="number" min={0} step={1} value={bulkStock} onChange={(event) => setBulkStock(event.target.value)} placeholder={t("quantity")} aria-label={t("quantity")} className="w-24" />
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
            disabled={bulkPrice === "" && bulkStock === "" && bulkImageId === undefined}
            onClick={applyBulk}
          >
            {t("apply")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selected.size >= variants.length}
            title={selected.size >= variants.length ? t("keepOneVariant") : undefined}
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
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>{t("clearSelection")}</Button>
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
              <th className="w-28 p-2 text-right font-medium">{t("quantity")}</th>
              <th className="w-24 p-2"><span className="sr-only">{r("actions")}</span></th>
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
                    <td className="p-2"><VariantImagePicker value={variant.imageId} images={images} label={t("photoFor", { name: nameOf(variant) })} onChange={(imageId) => onChange(variant.id, { imageId: imageId ?? null })} /></td>
                    <td className="p-2">
                      <button type="button" onClick={() => onExpandedChange(expanded ? null : variant.id)} className="flex min-h-10 w-full items-center gap-1.5 rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded}>
                        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <span className="min-w-0">
                          <span className="block truncate">{nameOf(variant)}</span>
                          <span className="block truncate font-mono font-normal text-muted-foreground">{variant.sku}</span>
                        </span>
                      </button>
                    </td>
                    <td className="p-2"><NumberInput value={variant.price} onChange={(price) => onChange(variant.id, { price })} ariaLabel={t("priceFor", { name: nameOf(variant) })} /></td>
                    <td className="p-2">
                      <InventoryQuantityInput
                        ariaLabel={t("quantityFor", { name: nameOf(variant) })}
                        value={variant.stock}
                        committed={committedByVariantId.get(variant.id) ?? 0}
                        onChange={(stock) => onChange(variant.id, { stock })}
                      />
                    </td>
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
                        <AdvancedSkuFields variant={variant} name={nameOf(variant)} onChange={(patch) => onChange(variant.id, patch)} />
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
              <VariantImagePicker value={variant.imageId} images={images} label={t("photoFor", { name: nameOf(variant) })} onChange={(imageId) => onChange(variant.id, { imageId: imageId ?? null })} />
              <strong className="min-w-0 flex-1 truncate text-body">{nameOf(variant)}</strong>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("moreFieldsFor", { name: nameOf(variant) })}
                aria-expanded={expandedId === variant.id}
                onClick={() => onExpandedChange(expandedId === variant.id ? null : variant.id)}
              >
                <ChevronDown className={cn("h-4 w-4", expandedId !== variant.id && "-rotate-90")} />
              </Button>
              <div className="flex shrink-0 justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={variants.length === 1}
                  title={variants.length === 1 ? t("keepOneVariant") : undefined}
                  aria-label={t("stopSellingVariant", { name: nameOf(variant) })}
                  onClick={() => onRemove(new Set([variant.id]))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                {variant.id.startsWith("var_") && !printingDisabled ? (
                  <Button asChild variant="ghost" size="icon">
                    <Link to="/admin/inventory/labels" search={{ variants: variant.id }} aria-label={t("printLabelFor", { name: nameOf(variant) })}>
                      <Printer className="h-4 w-4" />
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-body text-muted-foreground">{t("price")}<NumberInput value={variant.price} onChange={(price) => onChange(variant.id, { price })} ariaLabel={t("priceFor", { name: nameOf(variant) })} /></label>
              <label className="space-y-1 text-body text-muted-foreground">{t("quantity")}<InventoryQuantityInput ariaLabel={t("quantityFor", { name: nameOf(variant) })} value={variant.stock} committed={committedByVariantId.get(variant.id) ?? 0} onChange={(stock) => onChange(variant.id, { stock })} /></label>
            </div>
            {expandedId === variant.id ? <AdvancedSkuFields variant={variant} name={nameOf(variant)} onChange={(patch) => onChange(variant.id, patch)} /> : null}
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

function CompactInput({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) {
  return <Input value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel} />;
}

function NumberInput({ value, onChange, ariaLabel, integer = false }: { value: number; onChange: (value: number) => void; ariaLabel: string; integer?: boolean }) {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.max(0, integer ? Math.trunc(parsed) : parsed);
    setDraft(String(next));
    onChange(next);
  };
  return <Input type="number" min={0} step={integer ? 1 : "any"} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} aria-label={ariaLabel} />;
}

function InventoryQuantityInput({ value, committed, onChange, ariaLabel }: {
  value: number;
  committed: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
}) {
  const t = useMessages(productMessages);
  const available = Math.max(0, value - committed);
  return (
    <div className="space-y-1">
      <NumberInput value={value} integer onChange={onChange} ariaLabel={ariaLabel ?? t("quantity")} />
      {committed > 0 ? (
        <p className="text-right text-body text-muted-foreground tabular-nums" title={t("inOpenOrders", { onHand: value, committed })}>
          {t("availableToSell", { count: available })}
        </p>
      ) : null}
    </div>
  );
}

// Variant photo = an exact product image, or null to use the product's main photo.
function VariantImagePicker({ value, images, onChange, label, allowNoChange = false }: {
  value: string | null | undefined;
  images: ProductSkuImageChoice[];
  onChange: (value: string | null | undefined) => void;
  label?: string;
  allowNoChange?: boolean;
}) {
  const t = useMessages(productMessages);
  const selected = images.find((image) => image.id === value);
  const state = value === undefined
    ? t("photoNoChange")
    : value === null
      ? t("mainPhoto")
      : `${selected?.altText || t("photo")}${selected?.status === "trashed" ? ` (${t("mediaInTrash")})` : ""}`;
  const triggerLabel = `${label ?? t("variantPhoto")}: ${state}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="overflow-hidden" aria-label={triggerLabel}>
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
                aria-label={`${image.altText || t("photoNumber", { number: index + 1 })}${image.status === "trashed" ? ` (${t("mediaInTrash")})` : ""}`}
                className={cn(
                  "relative aspect-square overflow-hidden rounded border-2",
                  value === image.id ? "border-primary" : "border-transparent",
                  unavailable && "cursor-not-allowed opacity-45",
                )}
                title={image.status === "trashed" ? t("mediaInTrash") : image.altText || undefined}
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

function DiscountInput({ variant, name, onChange }: { variant: DraftVariant; name: string; onChange: (patch: Partial<DraftVariant>) => void }) {
  const t = useMessages(productMessages);
  const amount = variant.discountType === "flat" ? variant.discountAmount ?? 0 : variant.discountPercentage ?? 0;
  const [mode, setMode] = React.useState<"none" | "percentage" | "flat">(
    amount > 0 ? variant.discountType : "none",
  );
  return (
    <div className="flex min-w-0 gap-1">
      <Select
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
      >
        <SelectTrigger aria-label={t("discountTypeFor", { name })} className="min-w-24 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t("noDiscount")}</SelectItem>
          <SelectItem value="percentage">{t("discountPercentage")}</SelectItem>
          <SelectItem value="flat">{t("discountFixed")}</SelectItem>
        </SelectContent>
      </Select>
      {mode !== "none" ? (
        <Input
          type="number"
          min={0}
          max={mode === "percentage" ? 100 : undefined}
          value={amount}
          aria-label={t("discountValueFor", { name })}
          onChange={(event) => onChange(mode === "flat"
            ? { discountAmount: Math.max(0, event.target.valueAsNumber || 0) }
            : { discountPercentage: Math.min(100, Math.max(0, event.target.valueAsNumber || 0)) })}
          className="w-20"
        />
      ) : null}
    </div>
  );
}

function AdvancedSkuFields({ variant, name, onChange }: { variant: DraftVariant; name: string; onChange: (patch: Partial<DraftVariant>) => void }) {
  const t = useMessages(productMessages);
  const isUnsavedSku = variant.id.startsWith("draft_");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-body text-muted-foreground">
        {t("sku")}
        <CompactInput value={variant.sku} onChange={(sku) => onChange({ sku })} ariaLabel={t("skuFor", { name })} />
      </label>
      <label className="space-y-1 text-body text-muted-foreground">
        {t("discount")}
        <DiscountInput variant={variant} name={name} onChange={onChange} />
      </label>
      <label className="space-y-1 text-body text-muted-foreground">
        {t("barcodeType")}
        <Select value={variant.barcodeType ?? "none"} onValueChange={(value) => onChange({ barcodeType: value === "none" ? null : value as DraftVariant["barcodeType"], barcode: value === "none" ? null : variant.barcode })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t(isUnsavedSku ? "barcodeAuto" : "noBarcode")}</SelectItem>
            <SelectItem value="ean13">EAN-13</SelectItem>
            <SelectItem value="upc">UPC</SelectItem>
            <SelectItem value="isbn">ISBN</SelectItem>
            <SelectItem value="gtin">GTIN</SelectItem>
            <SelectItem value="code128">Code 128</SelectItem>
            <SelectItem value="custom">{t("barcodeCustom")}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="space-y-1 text-body text-muted-foreground">
        {t("barcode")}
        <Input
          value={variant.barcode ?? ""}
          disabled={!variant.barcodeType}
          placeholder={!variant.barcodeType ? t(isUnsavedSku ? "barcodeAutoHint" : "noBarcode") : undefined}
          aria-label={t("barcodeFor", { name })}
          onChange={(event) => onChange({ barcode: event.target.value || null })}
        />
      </label>
      <label className="space-y-1 text-body text-muted-foreground">
        {t("weightGrams")}
        <Input
          type="number"
          min={0}
          inputMode="numeric"
          value={variant.weight ?? ""}
          aria-label={t("weightFor", { name })}
          onChange={(event) => onChange({ weight: event.target.value === "" ? null : Math.max(0, event.target.valueAsNumber || 0) })}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-body md:min-h-8">
        <Switch checked={variant.trackInventory} onCheckedChange={(trackInventory) => onChange({ trackInventory })} />
        {t("trackQuantity")}
      </label>
    </div>
  );
}
