import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ImageIcon,
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
  materializeVariants,
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
    setVariants((current) => materializeVariants(options, current, productName, productPrice, requiredStockAllocation));
    setTopologyChanged(optionTopologySignature(options) !== savedTopology);
    setCombinationsPending(false);
    setDirty(true);
  }, [combinationCount, options, productName, productPrice, requiredStockAllocation, savedTopology, validShape]);

  const updateVariant = React.useCallback((id: string, patch: Partial<DraftVariant>) => {
    setVariants((current) => current.map((variant) => variant.id === id ? { ...variant, ...patch } : variant));
    setDirty(true);
  }, []);

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
            {dirty ? <Badge variant="outline" className="h-5 text-[10px]">Unsaved</Badge> : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Options are customer choices. Every combination below is one sellable SKU.
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
          <span className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">Saved with product</span>
        )}
      </div>

      <div className="rounded-lg border bg-muted/15 p-2.5">
        <div className="space-y-2">
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
          {options.length < MAX_AXES ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
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
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2 text-[11px]">
          {options.length ? options.map((option, index) => (
            <React.Fragment key={option.id}>
              {index ? <span className="text-muted-foreground">×</span> : null}
              <Badge variant="secondary" className="h-5 rounded px-1.5 font-normal">
                {option.values.length} {option.name.trim() || `Option ${index + 1}`}
              </Badge>
            </React.Fragment>
          )) : <span className="text-muted-foreground">Add an option such as Size, Color, Format, Shape, or Pack.</span>}
          {options.length ? (
            <>
              <span className="text-muted-foreground">=</span>
              <strong className={cn(combinationCount > MAX_COMBINATIONS && "text-destructive")}>
                {combinationCount} SKUs
              </strong>
              <span className="text-muted-foreground">· limit {MAX_COMBINATIONS}</span>
              {combinationsPending ? <Badge variant="outline" className="h-5 border-amber-300 bg-amber-50 px-1.5 text-[10px] text-amber-800">Changes pending</Badge> : null}
            </>
          ) : null}
          {combinationsPending && validShape && combinationCount <= MAX_COMBINATIONS ? (
            <Button type="button" size="sm" className="ml-auto h-7 px-2.5 text-[11px]" onClick={applyOptions}>
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
    <div className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[150px_1fr_82px]">
      <div className="space-y-1">
        <Input
          value={option.name}
          onChange={(event) => onChange({ ...option, name: event.target.value })}
          placeholder={`Option ${index + 1} name`}
          aria-label={`Option ${index + 1} name`}
          className="h-8 text-xs"
        />
        <Select
          value={option.standardMapping}
          onValueChange={(value) => onChange({ ...option, standardMapping: value as ProductOptionStandardMapping })}
        >
          <SelectTrigger aria-label={`Catalog mapping for ${option.name || `option ${index + 1}`}`} className="h-7 border-0 px-1.5 text-[10px] text-muted-foreground shadow-none">
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
      <div className="flex min-w-0 flex-wrap content-start gap-1 rounded-md border px-1.5 py-1">
        {option.values.map((value) => (
          <span key={value.id} className="inline-flex h-6 items-center gap-1 rounded bg-muted px-1.5 text-[11px]">
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
          className="h-6 min-w-[130px] flex-1 bg-transparent px-1 text-[11px] outline-none"
          aria-label={`Add ${option.name || `option ${index + 1}`} value`}
        />
      </div>
      <div className="flex justify-end gap-0.5">
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

function VariantMatrix({ options, variants, images, expandedId, onExpandedChange, onChange, committedByVariantId }: {
  options: DraftOption[];
  variants: DraftVariant[];
  images: ProductImageDetail[];
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
  onChange: (id: string, patch: Partial<DraftVariant>) => void;
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
          <span className="ml-2 text-[11px] text-muted-foreground">{variants.length} combinations · changes save together</span>
        </div>
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find option or SKU" aria-label="Find option or SKU" className="h-8 w-44 pl-7 text-xs" />
        </label>
      </div>
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-primary/5 px-3 py-1.5 text-[11px]">
          <strong>{selected.size} selected</strong>
          <Input type="number" min={0} value={bulkPrice} onChange={(event) => setBulkPrice(event.target.value)} placeholder="Price" aria-label="Bulk price" className="h-7 w-24 bg-background text-xs" />
          <Input type="number" min={0} step={1} value={bulkStock} onChange={(event) => setBulkStock(event.target.value)} placeholder="Stock" aria-label="Bulk stock" className="h-7 w-24 bg-background text-xs" />
          <VariantImagePicker
            value={null}
            images={images}
            label="Set image for selected SKUs"
            onChange={(imageId) => selected.forEach((id) => onChange(id, { imageId }))}
          />
          <Button type="button" size="sm" className="h-7 px-2 text-[11px]" disabled={bulkPrice === "" && bulkStock === ""} onClick={applyBulk}>Apply</Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      ) : null}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[860px] table-fixed text-xs">
          <thead className="border-b bg-muted/10 text-[10px] uppercase tracking-wide text-muted-foreground">
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
              <th className="w-[24%] p-2 text-left">Combination</th>
              <th className="w-14 p-2 text-left">Image</th>
              <th className="w-[22%] p-2 text-left">SKU</th>
              <th className="w-[13%] p-2 text-left">Price</th>
              <th className="w-[12%] p-2 text-left">On hand</th>
              <th className="p-2 text-left">Discount</th>
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
                      <NumberInput value={variant.stock} integer onChange={(stock) => onChange(variant.id, { stock })} ariaLabel="On-hand stock" />
                      {(committedByVariantId.get(variant.id) ?? 0) > 0 ? <span className="mt-0.5 block text-[9px] text-muted-foreground">{committedByVariantId.get(variant.id)} committed · {Math.max(0, variant.stock - (committedByVariantId.get(variant.id) ?? 0))} available</span> : null}
                    </td>
                    <td className="p-1.5"><DiscountInput variant={variant} onChange={(patch) => onChange(variant.id, patch)} /></td>
                  </tr>
                  {expanded ? (
                    <tr className="bg-muted/10">
                      <td />
                      <td colSpan={6} className="p-2.5">
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
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-1 text-[10px] text-muted-foreground">SKU<CompactInput value={variant.sku} onChange={(sku) => onChange(variant.id, { sku })} ariaLabel="SKU" /></label>
              <label className="space-y-1 text-[10px] text-muted-foreground">Price<NumberInput value={variant.price} onChange={(price) => onChange(variant.id, { price })} ariaLabel="Price" /></label>
              <label className="space-y-1 text-[10px] text-muted-foreground">On hand<NumberInput value={variant.stock} integer onChange={(stock) => onChange(variant.id, { stock })} ariaLabel="On-hand stock" /></label>
              <label className="space-y-1 text-[10px] text-muted-foreground">Discount<DiscountInput variant={variant} onChange={(patch) => onChange(variant.id, patch)} /></label>
            </div>
            {expandedId === variant.id ? <AdvancedSkuFields variant={variant} onChange={(patch) => onChange(variant.id, patch)} /> : null}
          </div>
        ))}
      </div>
      {filteredVariants.length === 0 ? <div className="px-3 py-6 text-center text-xs text-muted-foreground">No SKUs match this search.</div> : null}
      <div className="flex items-center justify-between border-t bg-muted/15 px-3 py-2 text-[10px] text-muted-foreground">
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
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[10px]" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</Button>
              <span>{safePage + 1}/{pageCount}</span>
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[10px]" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CompactInput({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) {
  return <Input value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel} className="h-8 px-2 text-xs" />;
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
  return <Input type="number" min={0} step={integer ? 1 : "any"} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} aria-label={ariaLabel} className="h-8 px-2 text-xs" />;
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
        {images.length === 0 ? <p className="px-1 py-2 text-[11px] text-muted-foreground">Add media to the product first, then assign it here.</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function DiscountInput({ variant, onChange }: { variant: DraftVariant; onChange: (patch: Partial<DraftVariant>) => void }) {
  const value = variant.discountType === "flat" ? variant.discountAmount ?? 0 : variant.discountPercentage ?? 0;
  return (
    <div className="flex h-8 overflow-hidden rounded-md border bg-background">
      <button
        type="button"
        className="w-8 border-r text-[10px] text-muted-foreground"
        onClick={() => onChange(variant.discountType === "flat"
          ? { discountType: "percentage", discountAmount: null }
          : { discountType: "flat", discountPercentage: null })}
        title="Switch discount type"
      >
        {variant.discountType === "flat" ? "৳" : "%"}
      </button>
      <input
        type="number"
        min={0}
        max={variant.discountType === "percentage" ? 100 : undefined}
        value={value}
        aria-label="Variant discount"
        onChange={(event) => onChange(variant.discountType === "flat"
          ? { discountAmount: Math.max(0, event.target.valueAsNumber || 0) }
          : { discountPercentage: Math.min(100, Math.max(0, event.target.valueAsNumber || 0)) })}
        className="w-full min-w-0 bg-transparent px-2 text-xs outline-none"
      />
    </div>
  );
}

function AdvancedSkuFields({ variant, onChange }: { variant: DraftVariant; onChange: (patch: Partial<DraftVariant>) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[140px_1fr_130px_auto] sm:items-end">
      <label className="space-y-1 text-[10px] text-muted-foreground">
        Barcode type
        <Select value={variant.barcodeType ?? "none"} onValueChange={(value) => onChange({ barcodeType: value === "none" ? null : value as DraftVariant["barcodeType"], barcode: value === "none" ? null : variant.barcode })}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="ean13">EAN-13</SelectItem>
            <SelectItem value="upc">UPC</SelectItem>
            <SelectItem value="isbn">ISBN</SelectItem>
            <SelectItem value="gtin">GTIN</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="space-y-1 text-[10px] text-muted-foreground">
        Barcode
        <Input value={variant.barcode ?? ""} disabled={!variant.barcodeType} onChange={(event) => onChange({ barcode: event.target.value || null })} className="h-8 text-xs" />
      </label>
      <label className="space-y-1 text-[10px] text-muted-foreground">
        Weight
        <Input type="number" min={0} value={variant.weight ?? ""} onChange={(event) => onChange({ weight: event.target.value === "" ? null : Math.max(0, event.target.valueAsNumber || 0) })} className="h-8 text-xs" />
      </label>
      <label className="flex h-8 items-center gap-2 text-xs">
        <Switch checked={variant.trackInventory} onCheckedChange={(trackInventory) => onChange({ trackInventory })} />
        Track stock
      </label>
    </div>
  );
}
