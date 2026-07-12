import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ImageIcon,
  Info,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";
import { saveProductOptionMatrix, type ProductOptionMatrixInput } from "@/lib/api-functions/products";
import { getServerFnError } from "@/lib/api-helpers";
import { readProductRevisionConflict, type ProductRevisionConflict } from "@/lib/admin-api-error";
import type {
  ProductImageDetail,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "@/types/api-responses";
import {
  draftId,
  getOptionMatrixIssue,
  initialOptions,
  initialVariants,
  combinationKey,
  materializeCombination,
  materializeVariants,
  materializeVariantsExcluding,
  missingOptionCombinations,
  normalized,
  optionTopologySignature,
  type DraftOption,
  type DraftVariant,
  type OptionMatrixEditorHandle,
} from "./option-matrix-editor-model";

const MAX_AXES = MAX_PRODUCT_OPTION_AXES;
const MAX_COMBINATIONS = MAX_PRODUCT_OPTION_COMBINATIONS;

type OptionMatrixEditorProps = {
  productId?: string;
  productName: string;
  productPrice: number;
  options?: ProductOptionDefinition[];
  variants?: ProductVariant[];
  images: ProductImageDetail[];
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onSaved?: () => void;
  onDraftChange?: (matrix: Omit<ProductOptionMatrixInput, "expectedAggregateRevision"> | null) => void;
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
  const queryClient = useQueryClient();
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
  const defaultSku = savedVariants.find((variant) => variant.isDefault && !variant.deletedAt);
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
  );

  React.useEffect(() => {
    if (!onDraftChange) return;
    onDraftChange(!matrixIssue && options.length > 0
      ? { options, variants }
      : null);
  }, [matrixIssue, onDraftChange, options, variants]);

  React.useEffect(() => onDraftIssueChange?.(matrixIssue), [matrixIssue, onDraftIssueChange]);
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
    mutationFn: (revisionOverride?: number) => saveProductOptionMatrix({
      data: {
        productId: productId!,
        matrix: { options, variants, expectedAggregateRevision: revisionOverride ?? aggregateRevision! },
      },
    }),
    onSuccess: (result) => {
      onAggregateRevisionChange?.(result.aggregateRevision);
      setDirty(false);
      setCombinationsPending(false);
      setTopologyChanged(false);
      setOmittedVariantsByKey(new Map());
      void queryClient.invalidateQueries({ queryKey: ["products", productId] });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Options and SKUs saved");
      onSaved?.();
    },
    onError: (error) => {
      const conflict = readProductRevisionConflict(error);
      if (conflict) {
        onRevisionConflict?.(conflict);
        return;
      }
      toast.error(getServerFnError(error, "Could not save the option matrix"));
    },
  });

  React.useEffect(() => onSavingChange?.(mutation.isPending), [mutation.isPending, onSavingChange]);
  React.useImperativeHandle(ref, () => ({
    save: (revisionOverride) => {
      if (!productId || !dirty || matrixIssue || mutation.isPending) return;
      mutation.mutate(revisionOverride);
    },
  }), [dirty, matrixIssue, mutation, productId]);

  return (
    <section data-option-matrix data-variant-editor tabIndex={-1} className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Options and SKUs</h3>
            {dirty ? <Badge variant="outline" className="h-5 text-xs">Unsaved</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Options are customer choices. Keep only the combinations you actually sell.
          </p>
        </div>
        {productId ? (
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            disabled={!dirty || Boolean(matrixIssue) || mutation.isPending}
            onClick={() => mutation.mutate(undefined)}
          >
            {mutation.isPending ? "Saving…" : "Save options"}
          </Button>
        ) : (
          <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">Saved with product</span>
        )}
      </div>

      <div className="rounded-lg border bg-muted/10 p-1.5">
        {options.length ? (
          <div className="divide-y overflow-hidden rounded-md border bg-background">
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
                onChange={(next) => stageOptions(options.map((item) => item.id === option.id ? next : item))}
                onRemove={() => stageOptions(options.filter((item) => item.id !== option.id))}
              />
            ))}
          </div>
        ) : null}
        <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1.5 text-xs">
          {options.length < MAX_AXES ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-sm text-muted-foreground"
              onClick={() => stageOptions([...options, {
                id: draftId("option"),
                name: "",
                standardMapping: "none",
                values: [],
              }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add option
            </Button>
          ) : null}
          {options.length ? <span aria-hidden="true" className="h-4 w-px bg-border" /> : null}
          {options.length ? options.map((option, index) => (
            <React.Fragment key={option.id}>
              {index ? <span className="text-muted-foreground">×</span> : null}
              <span className="whitespace-nowrap text-muted-foreground">
                <span className="font-medium text-foreground">{option.values.length}</span>{" "}
                {option.name.trim() || `Option ${index + 1}`}
              </span>
            </React.Fragment>
          )) : <span className="text-muted-foreground">Try Size, Color, Format, Shape, or Pack.</span>}
          {options.length ? (
            <>
              <span className="text-muted-foreground">=</span>
              <strong className={cn(combinationCount > MAX_COMBINATIONS && "text-destructive")}>
                {combinationCount} possible
              </strong>
              {!combinationsPending && missingCombinations.length > 0 ? (
                <span className="text-muted-foreground">· {variants.length} active</span>
              ) : null}
              <span className="text-muted-foreground">/ {MAX_COMBINATIONS} max</span>
              {combinationsPending ? <Badge variant="outline" className="h-5 border-amber-300 bg-amber-50 px-1.5 text-xs text-amber-800">Changes pending</Badge> : null}
            </>
          ) : null}
          {combinationsPending && validShape && combinationCount <= MAX_COMBINATIONS ? (
            <Button type="button" size="sm" className="ml-auto h-7 px-2.5 text-xs" onClick={applyOptions}>
              Update combinations
            </Button>
          ) : null}
        </div>
      </div>

      {matrixIssue && options.length > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
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
        />
      ) : !combinationsPending ? (
        <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
          Add a value to every option to generate the SKU matrix.
        </div>
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
  const [valueInput, setValueInput] = React.useState("");
  const addValues = () => {
    const existing = new Set(option.values.map((value) => value.value.trim().toLocaleLowerCase("en-US")));
    const nextValues = valueInput.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      .flatMap((value) => {
        const identity = value.toLocaleLowerCase("en-US");
        if (existing.has(identity)) return [];
        existing.add(identity);
        return [{ id: draftId("value"), value }];
      });
    if (!nextValues.length) return;
    onChange({ ...option, values: [...option.values, ...nextValues] });
    setValueInput("");
  };

  return (
    <div className="grid gap-1.5 p-1.5 sm:grid-cols-[260px_minmax(0,1fr)_82px] sm:items-center">
      <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-1">
        <Input
          value={option.name}
          onChange={(event) => onChange({ ...option, name: event.target.value })}
          placeholder={`Option ${index + 1} name`}
          aria-label={`Option ${index + 1} name`}
          className="h-8 text-sm"
        />
        <Select
          value={option.standardMapping}
          onValueChange={(value) => onChange({ ...option, standardMapping: value as ProductOptionStandardMapping })}
        >
          <SelectTrigger aria-label={`Catalog mapping for ${option.name || `option ${index + 1}`}`} className="h-8 px-2 text-xs text-muted-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No feed mapping</SelectItem>
            <SelectItem value="size">Maps to size</SelectItem>
            <SelectItem value="color">Maps to color</SelectItem>
            <SelectItem value="material">Maps to material</SelectItem>
            <SelectItem value="pattern">Maps to pattern</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-8 min-w-0 flex-wrap content-center gap-1 rounded-md border px-1.5 py-0.5">
        {option.values.map((value) => (
          <span key={value.id} className="inline-flex h-6 items-center gap-1 rounded bg-muted px-1.5 text-xs">
            {value.value}
            <button
              type="button"
              aria-label={`Remove ${value.value}`}
              onClick={() => onChange({ ...option, values: option.values.filter((item) => item.id !== value.id) })}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
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
          placeholder={option.values.length ? "Add value" : "Type values, press Enter"}
          className="h-6 min-w-[130px] flex-1 bg-transparent px-1 text-sm outline-none"
          aria-label={`Add ${option.name || `option ${index + 1}`} value`}
        />
      </div>
      <div className="flex items-center justify-end gap-0.5">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-6 text-muted-foreground" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3.5 w-3.5" /><span className="sr-only">Move option up</span>
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-6 text-muted-foreground" disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown className="h-3.5 w-3.5" /><span className="sr-only">Move option down</span>
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-7 text-muted-foreground hover:text-destructive" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" /><span className="sr-only">Remove option</span>
        </Button>
      </div>
    </div>
  );
}

function VariantMatrix({ options, variants, images, expandedId, onExpandedChange, onChange, onRemove, missingCombinations, onRestoreCombination, onRestoreAll, committedByVariantId }: {
  options: DraftOption[];
  variants: DraftVariant[];
  images: ProductImageDetail[];
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
  onChange: (id: string, patch: Partial<DraftVariant>) => void;
  onRemove: (ids: ReadonlySet<string>) => void;
  missingCombinations: string[][];
  onRestoreCombination: (valueIds: string[]) => void;
  onRestoreAll: () => void;
  committedByVariantId: ReadonlyMap<string, number>;
}) {
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [bulkPrice, setBulkPrice] = React.useState("");
  const [bulkStock, setBulkStock] = React.useState("");
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
    }));
    setBulkPrice("");
    setBulkStock("");
  };
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/25 px-3 py-2">
        <div>
          <span className="text-xs font-medium">SKU matrix</span>
          <span className="ml-2 text-xs text-muted-foreground">{variants.length} active · changes save together</span>
        </div>
        <div className="flex items-center gap-1.5">
          {missingCombinations.length > 0 ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs">
                  {missingCombinations.length} omitted
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-2">
                <div className="flex items-center justify-between gap-2 border-b px-1 pb-2">
                  <div>
                    <p className="text-xs font-medium">Omitted combinations</p>
                    <p className="text-xs text-muted-foreground">Not offered for sale. Saved omissions reactivate prior SKU inventory; edit it after restore.</p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onRestoreAll}>Restore all</Button>
                </div>
                <div className="max-h-56 overflow-y-auto pt-1">
                  {missingCombinations.map((valueIds) => {
                    const label = valueIds.map((id) => valueLabel.get(id) ?? "Unknown value").join(" / ");
                    return (
                      <button
                        key={combinationKey(valueIds)}
                        type="button"
                        onClick={() => onRestoreCombination(valueIds)}
                        className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate">{label}</span>
                        <span className="shrink-0 text-muted-foreground">Restore</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find option or SKU" aria-label="Find option or SKU" className="h-8 w-44 pl-7 text-xs" />
          </label>
        </div>
      </div>
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-primary/5 px-3 py-1.5 text-xs">
          <strong>{selected.size} selected</strong>
          <Input type="number" min={0} value={bulkPrice} onChange={(event) => setBulkPrice(event.target.value)} placeholder="Price" aria-label="Bulk price" className="h-7 w-24 bg-background text-xs" />
          <Input type="number" min={0} step={1} value={bulkStock} onChange={(event) => setBulkStock(event.target.value)} placeholder="Stock" aria-label="Bulk stock" className="h-7 w-24 bg-background text-xs" />
          <VariantImagePicker
            value={null}
            images={images}
            label="Set image for selected SKUs"
            onChange={(imageId) => selected.forEach((id) => onChange(id, { imageId }))}
          />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={bulkPrice === "" && bulkStock === ""} onClick={applyBulk}>Apply</Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-destructive"
            disabled={selected.size >= variants.length}
            title={selected.size >= variants.length ? "At least one sellable combination is required" : "Omit selected combinations from this product"}
            onClick={() => {
              onRemove(selected);
              setSelected(new Set());
            }}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Omit selected
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      ) : null}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1040px] table-fixed text-xs">
          <thead className="border-b bg-muted/10 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-9 p-2 text-center">
                <input type="checkbox" checked={allVisibleSelected} onChange={(event) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    visibleVariants.forEach((variant) => event.target.checked ? next.add(variant.id) : next.delete(variant.id));
                    return next;
                  });
                }} aria-label="Select visible SKUs" className="h-3.5 w-3.5" />
              </th>
              <th className="w-[20%] p-2 text-left">Combination</th>
              <th className="w-14 p-2 text-left">Image</th>
              <th className="w-[20%] p-2 text-left">SKU</th>
              <th className="w-[11%] p-2 text-left">Price</th>
              <th className="w-[11%] p-2 text-left">On hand</th>
              <th className="w-[23%] p-2 text-left">Discount</th>
              <th className="w-11 p-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {visibleVariants.map((variant) => {
              const expanded = expandedId === variant.id;
              return (
                <React.Fragment key={variant.id}>
                  <tr className="align-middle hover:bg-muted/15">
                    <td className="p-1.5 text-center">
                      <input type="checkbox" checked={selected.has(variant.id)} onChange={(event) => toggleSelected(variant.id, event.target.checked)} aria-label={`Select ${variant.sku}`} className="h-3.5 w-3.5" />
                    </td>
                    <td className="p-2 font-medium">
                      <button type="button" onClick={() => onExpandedChange(expanded ? null : variant.id)} className="flex w-full items-center gap-1.5 text-left" aria-expanded={expanded}>
                        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate">{variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}</span>
                      </button>
                    </td>
                    <td className="p-1.5"><VariantImagePicker value={variant.imageId} images={images} onChange={(imageId) => onChange(variant.id, { imageId })} /></td>
                    <td className="p-1.5"><CompactInput value={variant.sku} onChange={(sku) => onChange(variant.id, { sku })} ariaLabel="SKU" /></td>
                    <td className="p-1.5"><NumberInput value={variant.price} onChange={(price) => onChange(variant.id, { price })} ariaLabel="Price" /></td>
                    <td className="p-1.5">
                      <InventoryQuantityInput
                        value={variant.stock}
                        committed={committedByVariantId.get(variant.id) ?? 0}
                        onChange={(stock) => onChange(variant.id, { stock })}
                      />
                    </td>
                    <td className="p-1.5"><DiscountInput variant={variant} onChange={(patch) => onChange(variant.id, patch)} /></td>
                    <td className="p-1.5 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        disabled={variants.length === 1}
                        title={variants.length === 1 ? "At least one sellable combination is required" : "Omit this combination"}
                        aria-label={`Omit ${variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}`}
                        onClick={() => onRemove(new Set([variant.id]))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="bg-muted/10">
                      <td />
                      <td colSpan={7} className="p-2.5">
                        <AdvancedSkuFields variant={variant} onChange={(patch) => onChange(variant.id, patch)} />
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
          <div key={variant.id} className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={selected.has(variant.id)} onChange={(event) => toggleSelected(variant.id, event.target.checked)} aria-label={`Select ${variant.sku}`} className="h-3.5 w-3.5" />
              <VariantImagePicker value={variant.imageId} images={images} onChange={(imageId) => onChange(variant.id, { imageId })} />
              <strong className="min-w-0 flex-1 truncate text-xs">{variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}</strong>
              <button
                type="button"
                aria-label={`${expandedId === variant.id ? "Hide" : "Show"} additional fields for ${variant.sku}`}
                aria-expanded={expandedId === variant.id}
                onClick={() => onExpandedChange(expandedId === variant.id ? null : variant.id)}
              >
                <ChevronDown className={cn("h-4 w-4 transition-transform", expandedId !== variant.id && "-rotate-90")} />
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={variants.length === 1}
                title={variants.length === 1 ? "At least one sellable combination is required" : "Omit this combination"}
                aria-label={`Omit ${variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ")}`}
                onClick={() => onRemove(new Set([variant.id]))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-1 text-xs text-muted-foreground">SKU<CompactInput value={variant.sku} onChange={(sku) => onChange(variant.id, { sku })} ariaLabel="SKU" /></label>
              <label className="space-y-1 text-xs text-muted-foreground">Price<NumberInput value={variant.price} onChange={(price) => onChange(variant.id, { price })} ariaLabel="Price" /></label>
              <label className="space-y-1 text-xs text-muted-foreground">On hand<InventoryQuantityInput value={variant.stock} committed={committedByVariantId.get(variant.id) ?? 0} onChange={(stock) => onChange(variant.id, { stock })} /></label>
              <label className="space-y-1 text-xs text-muted-foreground">Discount<DiscountInput variant={variant} onChange={(patch) => onChange(variant.id, patch)} /></label>
            </div>
            {expandedId === variant.id ? <AdvancedSkuFields variant={variant} onChange={(patch) => onChange(variant.id, patch)} /> : null}
          </div>
        ))}
      </div>
      {filteredVariants.length === 0 ? <div className="px-3 py-6 text-center text-xs text-muted-foreground">No SKUs match this search.</div> : null}
      <div className="flex items-center justify-between border-t bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {filteredVariants.length
            ? `Showing ${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, filteredVariants.length)} of ${filteredVariants.length}`
            : "Showing 0"}
          {filteredVariants.length !== variants.length ? ` · ${variants.length} total` : ""}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="hidden sm:inline">Zero stock is valid and appears sold out</span>
          {pageCount > 1 ? (
            <>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</Button>
              <span>{safePage + 1}/{pageCount}</span>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CompactInput({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) {
  return <Input value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel} className="h-8 px-2 text-sm" />;
}

function NumberInput({ value, onChange, ariaLabel, integer = false, className }: { value: number; onChange: (value: number) => void; ariaLabel: string; integer?: boolean; className?: string }) {
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
  return <Input type="number" min={0} step={integer ? 1 : "any"} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} aria-label={ariaLabel} className={cn("h-8 px-2 text-sm", className)} />;
}

function InventoryQuantityInput({ value, committed, onChange }: {
  value: number;
  committed: number;
  onChange: (value: number) => void;
}) {
  const available = Math.max(0, value - committed);
  return (
    <div className="relative">
      <NumberInput
        value={value}
        integer
        onChange={onChange}
        ariaLabel="On-hand stock"
        className={committed > 0 ? "pr-8" : undefined}
      />
      {committed > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${available} available to sell; ${committed} committed from ${value} on hand`}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64">
            <p className="font-medium">{available} available to sell</p>
            <p className="opacity-80">{value} on hand − {committed} committed to open orders</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function VariantImagePicker({ value, images, onChange, label = "Choose SKU image" }: { value: string | null; images: ProductImageDetail[]; onChange: (value: string | null) => void; label?: string }) {
  const selected = images.find((image) => image.id === value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-8 w-10 items-center justify-center overflow-hidden rounded border bg-background" aria-label={label}>
          {selected ? <img src={getOptimizedImageUrl(selected.url)} alt="" className="h-full w-full object-cover" /> : <ImageIcon className="h-4 w-4 text-muted-foreground" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <button type="button" onClick={() => onChange(null)} className={cn("mb-1 flex w-full items-center gap-2 rounded p-1.5 text-left text-xs hover:bg-muted", value === null && "bg-muted")}>
          <span className="flex h-9 w-9 items-center justify-center rounded border"><ImageIcon className="h-4 w-4" /></span>
          Use primary image
        </button>
        <div className="grid max-h-56 grid-cols-4 gap-1 overflow-y-auto">
          {images.map((image) => (
            <button key={image.id} type="button" onClick={() => onChange(image.id)} className={cn("aspect-square overflow-hidden rounded border-2", value === image.id ? "border-primary" : "border-transparent")} title={image.alt ?? "Product image"}>
              <img src={getOptimizedImageUrl(image.url)} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
        {images.length === 0 ? <p className="px-1 py-2 text-xs text-muted-foreground">Add media to the product first, then assign it here.</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function DiscountInput({ variant, onChange }: { variant: DraftVariant; onChange: (patch: Partial<DraftVariant>) => void }) {
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
        <SelectTrigger aria-label={`Discount type for ${variant.sku}`} className="h-8 min-w-[104px] flex-1 px-2 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None</SelectItem>
          <SelectItem value="percentage">Percentage</SelectItem>
          <SelectItem value="flat">Fixed amount</SelectItem>
        </SelectContent>
      </Select>
      {mode !== "none" ? (
        <Input
          type="number"
          min={0}
          max={mode === "percentage" ? 100 : undefined}
          value={amount}
          aria-label={`${mode === "percentage" ? "Percentage" : "Fixed amount"} discount for ${variant.sku}`}
          onChange={(event) => onChange(mode === "flat"
            ? { discountAmount: Math.max(0, event.target.valueAsNumber || 0) }
            : { discountPercentage: Math.min(100, Math.max(0, event.target.valueAsNumber || 0)) })}
          className="h-8 w-20 px-2 text-sm"
        />
      ) : null}
    </div>
  );
}

function AdvancedSkuFields({ variant, onChange }: { variant: DraftVariant; onChange: (patch: Partial<DraftVariant>) => void }) {
  const isUnsavedSku = variant.id.startsWith("draft_");
  return (
    <div className="grid gap-2 sm:grid-cols-[140px_1fr_130px_auto] sm:items-end">
      <label className="space-y-1 text-xs text-muted-foreground">
        Barcode type
        <Select value={variant.barcodeType ?? "none"} onValueChange={(value) => onChange({ barcodeType: value === "none" ? null : value as DraftVariant["barcodeType"], barcode: value === "none" ? null : variant.barcode })}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{isUnsavedSku ? "Automatic" : "No barcode"}</SelectItem>
            <SelectItem value="ean13">EAN-13</SelectItem>
            <SelectItem value="upc">UPC</SelectItem>
            <SelectItem value="isbn">ISBN</SelectItem>
            <SelectItem value="gtin">GTIN</SelectItem>
            <SelectItem value="code128">Internal Code 128</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        Barcode value
        <Input
          value={variant.barcode ?? ""}
          disabled={!variant.barcodeType}
          placeholder={!variant.barcodeType
            ? isUnsavedSku ? "Generated automatically on save" : "No barcode"
            : "Enter barcode"}
          aria-label={`Barcode for ${variant.sku}`}
          onChange={(event) => onChange({ barcode: event.target.value || null })}
          className="h-8 text-sm disabled:opacity-100"
        />
        {!variant.barcodeType && isUnsavedSku ? (
          <span className="block text-xs text-muted-foreground">A unique internal Code 128 barcode will be generated automatically on save.</span>
        ) : null}
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        Weight
        <Input type="number" min={0} value={variant.weight ?? ""} onChange={(event) => onChange({ weight: event.target.value === "" ? null : Math.max(0, event.target.valueAsNumber || 0) })} className="h-8 text-sm" />
      </label>
      <label className="flex h-8 items-center gap-2 text-xs">
        <Switch checked={variant.trackInventory} onCheckedChange={(trackInventory) => onChange({ trackInventory })} />
        Track stock
      </label>
    </div>
  );
}
