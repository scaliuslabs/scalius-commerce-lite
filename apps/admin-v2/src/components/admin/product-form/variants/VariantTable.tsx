// Shopify's variant table: one line per variant (photo, name with its SKU,
// price, quantity, a "…" menu), grouped by an option with group-level edits,
// bulk edits on the selection, and arrow keys between the price and quantity
// fields. Rows are memoised, so typing re-renders only the row being edited.
import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, PenLine, Printer, Search, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { IdText } from "~/components/admin/data-table/cells";
import { DataTableRowActions, type ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { cn } from "@scalius/shared/utils";
import { requiresWholeCashAmounts } from "@scalius/shared/money";
import { useCurrency } from "@/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { ProductSkuImageChoice } from "~/lib/api-query-options/products";
import {
  combinationKey,
  defaultSkuPattern,
  groupVariants,
  normalized,
  skuFromPattern,
  type DraftIssue,
  type DraftOption,
  type DraftVariant,
  type VariantGroup,
} from "./option-matrix-editor-model";
import { AdvancedSkuFields, InventoryQuantityInput, VariantImagePicker, type IssueFor } from "./variant-fields";

/** Phone: select, photo, name, menu (price and quantity below). Wider: one line with every column. */
const ROW_GRID = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_6rem_2.25rem]";
/** The same rows with a Fulfilment column, shown only while variants differ (physical vs service). */
const ROW_GRID_KIND = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_6rem_7.5rem_2.25rem]";
type EditableKind = "physical" | "service";

type Money = ReturnType<typeof useCurrency> & {
  /** "৳12,692": a customer-facing amount without paisa when the currency is paid in whole units. */
  whole: (amount: number) => string;
};
type BulkPanel = "price" | "stock" | "sku" | "photo" | null;

/**
 * Past this many variants the groups open closed, as in Shopify: a product
 * with 150 variants opens with its 15 group rows, not 150 rows of fields (each
 * row mounts a photo picker, a checkbox and two inputs).
 */
export const GROUPS_OPEN_LIMIT = 30;

export type VariantTableProps = {
  options: DraftOption[];
  variants: DraftVariant[];
  images: ProductSkuImageChoice[];
  productName: string;
  nameOf: (variant: DraftVariant) => string;
  /** The problem currently shown on a field, if any. */
  issue: DraftIssue | null;
  /** Bring the row of a problem just revealed into view. */
  reveal: { variantId: string; nonce: number } | null;
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
  /** One change applied to several rows (bulk and group edits). */
  onChangeMany: (ids: ReadonlySet<string>, patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>)) => void;
  onRemove: (ids: ReadonlySet<string>) => void;
  missingCombinations: string[][];
  onRestoreCombination: (valueIds: string[]) => void;
  onRestoreAll: () => void;
  committedByVariantId: ReadonlyMap<string, number>;
  /** Labels print only for saved variants with nothing unsaved. */
  printingDisabled: boolean;
  /** Variants differ in what they are (physical or service): each row picks its own. */
  fulfilmentColumn?: boolean;
};

/** The latest function behind a stable identity, so memoised rows never re-render for it. */
function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const ref = React.useRef(fn);
  React.useLayoutEffect(() => {
    ref.current = fn;
  });
  return React.useCallback((...args: Args) => ref.current(...args), []);
}

/** Up/Down (and Enter) move between the same field in the rows above and below, like a sheet. */
function moveBetweenRows(event: React.KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLInputElement;
  const cell = target.dataset?.cell;
  if (!cell || event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey) ? 1
    : event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 0;
  if (step === 0) return;
  const cells = [...event.currentTarget.querySelectorAll<HTMLInputElement>(`input[data-cell="${cell}"]`)];
  const next = cells[cells.indexOf(target) + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.select();
}

export function VariantTable(props: VariantTableProps) {
  const { options, variants, missingCombinations } = props;
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const currency = useCurrency();
  const { code, symbol, fmt, salePrice } = currency;
  const money = React.useMemo(() => ({
    code, symbol, fmt, salePrice,
    whole: (amount: number) => (requiresWholeCashAmounts(code) ? `${symbol}${formatNumber(Math.round(amount))}` : fmt(amount)),
  }) as Money, [code, symbol, fmt, salePrice]);

  const kindColumn = Boolean(props.fulfilmentColumn);
  const grid = kindColumn ? ROW_GRID_KIND : ROW_GRID;
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<"all" | "notForSale">("all");
  const [groupAxis, setGroupAxis] = React.useState(0);
  const [groupsStartOpen] = React.useState(() => variants.length <= GROUPS_OPEN_LIMIT);
  // Groups the merchant opened or closed against that start.
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());
  const isOpen = (valueId: string) => groupsStartOpen !== toggled.has(valueId);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [panel, setPanel] = React.useState<BulkPanel>(null);
  const tableRef = React.useRef<HTMLDivElement>(null);

  const valueLabel = React.useMemo(
    () => new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const))),
    [options],
  );
  const grouped = options.length >= 2 && groupAxis < options.length;
  const filtered = React.useMemo(() => {
    const needle = normalized(query);
    if (!needle) return variants;
    return variants.filter((variant) => normalized(
      `${variant.selectedOptionValueIds.map((id) => valueLabel.get(id) ?? "").join(" ")} ${variant.sku} ${variant.barcode ?? ""}`,
    ).includes(needle));
  }, [query, valueLabel, variants]);
  const groups = React.useMemo(
    () => (grouped ? groupVariants(options, filtered, groupAxis) : []),
    [filtered, groupAxis, grouped, options],
  );
  // A grouped row reads only the other options ("White"); ungrouped rows read in full.
  const labelOf = (variant: DraftVariant) => grouped
    ? variant.selectedOptionValueIds.filter((_, index) => index !== groupAxis).map((id) => valueLabel.get(id) ?? "").join(" / ")
    : props.nameOf(variant);

  React.useEffect(() => {
    const available = new Set(variants.map((variant) => variant.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => available.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [variants]);
  React.useEffect(() => {
    if (missingCombinations.length === 0) setView("all");
  }, [missingCombinations.length]);
  // A revealed problem may sit in a collapsed group or be hidden by the search.
  React.useEffect(() => {
    const target = props.reveal;
    if (!target) return;
    const variant = variants.find((row) => row.id === target.variantId);
    if (!variant) return;
    setView("all");
    setQuery("");
    const valueId = variant.selectedOptionValueIds[groupAxis] ?? "";
    setToggled((current) => {
      const next = new Set(current);
      if (groupsStartOpen) next.delete(valueId);
      else next.add(valueId);
      return next;
    });
    requestAnimationFrame(() => tableRef.current
      ?.querySelector(`[data-variant-row="${CSS.escape(target.variantId)}"]`)
      ?.scrollIntoView({ block: "center" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.nonce]);

  const onChange = useStableCallback((id: string, patch: Partial<DraftVariant>) => props.onChangeMany(new Set([id]), patch));
  const onSelect = useStableCallback((ids: readonly string[], checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
    return next;
  }));
  const onToggleExpand = useStableCallback((id: string) => props.onExpandedChange(props.expandedId === id ? null : id));
  const onRemove = useStableCallback((id: string) => props.onRemove(new Set([id])));
  const onToggleGroup = useStableCallback((valueId: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(valueId)) next.delete(valueId);
    else next.add(valueId);
    return next;
  }));
  const onPrint = useStableCallback((ids: readonly string[]) =>
    void navigate({ to: "/admin/inventory/labels", search: { variants: ids.join(",") } }));

  const visibleIds = filtered.map((variant) => variant.id);
  const selectedCount = selected.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  const canRemoveAny = variants.length > 1;

  const row = (variant: DraftVariant, depth: 0 | 1) => (
    <VariantRow
      key={variant.id}
      variant={variant}
      name={props.nameOf(variant)}
      label={labelOf(variant)}
      depth={depth}
      selected={selected.has(variant.id)}
      expanded={props.expandedId === variant.id}
      issue={props.issue?.variantId === variant.id ? props.issue : null}
      committed={props.committedByVariantId.get(variant.id) ?? 0}
      images={props.images}
      money={money}
      canRemove={canRemoveAny}
      printable={!props.printingDisabled && variant.id.startsWith("var_")}
      kindColumn={kindColumn}
      onChange={onChange}
      onSelect={onSelect}
      onToggleExpand={onToggleExpand}
      onRemove={onRemove}
      onPrint={onPrint}
    />
  );

  return (
    <div className="border-t">
      {/* Toolbar: how the rows are grouped, which rows show, and a search. */}
      <div className="flex flex-wrap items-center gap-2 py-2">
        {options.length >= 2 ? (
          <label className="flex items-center gap-2 text-body text-muted-foreground">
            {t("groupBy")}
            <NativeSelect
              value={String(grouped ? groupAxis : -1)}
              onValueChange={(value) => setGroupAxis(Number(value) < 0 ? options.length : Number(value))}
              className="w-auto min-w-28"
            >
              {options.map((option, index) => (
                <option key={option.id} value={index}>{option.name.trim() || t("optionNumber", { number: index + 1 })}</option>
              ))}
              <option value={-1}>{t("groupByNone")}</option>
            </NativeSelect>
          </label>
        ) : null}
        {missingCombinations.length > 0 ? (
          <div role="group" aria-label={t("variants")} className="flex items-center gap-1">
            {(["all", "notForSale"] as const).map((key) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={view === key ? "secondary" : "ghost"}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >
                {key === "all"
                  ? t("showAllVariants", { count: variants.length })
                  : t("showNotForSale", { count: missingCombinations.length })}
              </Button>
            ))}
          </div>
        ) : null}
        <label className="relative ml-auto">
          <span className="sr-only">{t("findVariant")}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          {/* eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon, as in the list toolbar */}
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("findVariant")} className="w-44 pl-8" />
        </label>
      </div>

      {view === "notForSale" ? (
        <NotForSaleList
          combinations={missingCombinations}
          valueLabel={valueLabel}
          onRestore={props.onRestoreCombination}
          onRestoreAll={props.onRestoreAll}
        />
      ) : (
        <div ref={tableRef} onKeyDown={moveBetweenRows}>
          {/* The header turns into the bulk bar while rows are selected, so the table never shifts. */}
          <div className={cn(grid, "min-h-11 border-y bg-muted/50 text-body text-muted-foreground")}>
            <div className="flex justify-center">
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={() => onSelect(visibleIds, !allVisibleSelected)}
                aria-label={r("selectAll")}
              />
            </div>
            {selectedCount > 0 ? (
              <BulkBar
                count={selectedCount}
                allSelected={selectedCount >= variants.length}
                printableIds={props.printingDisabled ? [] : [...selected].filter((id) => id.startsWith("var_"))}
                printingDisabled={props.printingDisabled}
                wide={kindColumn}
                panel={panel}
                onPanel={setPanel}
                onClear={() => setSelected(new Set())}
                onPrint={onPrint}
                onRemove={() => {
                  props.onRemove(selected);
                  setSelected(new Set());
                }}
              />
            ) : (
              <>
                {/* Every column keeps a cell (sr-only would drop out of the grid and shift the headings). */}
                <span><span className="sr-only">{t("photo")}</span></span>
                <span className="font-medium">{t("variant")}</span>
                <span className="hidden font-medium md:block">{t("price")}</span>
                <span className="hidden font-medium md:block">{t("quantity")}</span>
                {kindColumn ? <span className="hidden font-medium md:block">{t("fulfilment")}</span> : null}
                <span className={kindColumn ? "col-start-4 md:col-start-7" : "col-start-4 md:col-start-6"}><span className="sr-only">{r("actions")}</span></span>
              </>
            )}
          </div>
          {selectedCount > 0 && panel ? (
            <BulkPanelRow
              panel={panel}
              options={options}
              images={props.images}
              money={money}
              productName={props.productName}
              selectedVariants={variants.filter((variant) => selected.has(variant.id))}
              onApply={(patch) => {
                props.onChangeMany(selected, patch);
                setPanel(null);
              }}
              onCancel={() => setPanel(null)}
            />
          ) : null}
          {selectedCount >= variants.length ? (
            <p id="variant-bulk-keep-one" className="border-b px-2 py-1.5 text-body text-muted-foreground">{t("keepOneVariant")}</p>
          ) : null}

          {grouped
            ? groups.map((group) => {
                const open = isOpen(group.valueId) || Boolean(query);
                return (
                  <React.Fragment key={group.valueId}>
                    <GroupRow
                      group={group}
                      open={open}
                      images={props.images}
                      money={money}
                      selectedCount={group.variants.filter((variant) => selected.has(variant.id)).length}
                      kindColumn={kindColumn}
                      onToggle={onToggleGroup}
                      onSelect={onSelect}
                      onChangeMany={props.onChangeMany}
                    />
                    {open ? group.variants.map((variant) => row(variant, 1)) : null}
                  </React.Fragment>
                );
              })
            : filtered.map((variant) => row(variant, 0))}
          {filtered.length === 0 ? <div className="px-3 py-6 text-center text-body text-muted-foreground">{r("noResults")}</div> : null}
        </div>
      )}
    </div>
  );
}

type VariantRowProps = {
  variant: DraftVariant;
  name: string;
  label: string;
  depth: 0 | 1;
  selected: boolean;
  expanded: boolean;
  issue: DraftIssue | null;
  committed: number;
  images: ProductSkuImageChoice[];
  money: Money;
  canRemove: boolean;
  printable: boolean;
  kindColumn: boolean;
  onChange: (id: string, patch: Partial<DraftVariant>) => void;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onToggleExpand: (id: string) => void;
  onRemove: (id: string) => void;
  onPrint: (ids: readonly string[]) => void;
};

const VariantRow = React.memo(function VariantRow({
  variant, name, label, depth, selected, expanded, issue, committed, images, money, canRemove, printable, kindColumn,
  onChange, onSelect, onToggleExpand, onRemove, onPrint,
}: VariantRowProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const errorOf = (field: DraftIssue["field"]) => (issue && issue.field === field ? issue.message : undefined);
  const issueFor: IssueFor = (_variantId, field) => errorOf(field);
  const priceError = errorOf("price");
  const stockError = errorOf("stock");
  const photoError = errorOf("photo");
  const sale = Number.isFinite(variant.price) && !errorOf("discount") ? money.salePrice(variant.price, variant) : null;
  const change = (patch: Partial<DraftVariant>) => onChange(variant.id, patch);
  const actions = React.useMemo<ExtraAction[]>(() => [
    { label: t("editDetails"), icon: PenLine, onClick: () => onToggleExpand(variant.id) },
    ...(printable ? [{ label: t("printLabels"), icon: Printer, onClick: () => onPrint([variant.id]) }] : []),
    ...(canRemove ? [{ label: t("stopSelling"), icon: Trash2, destructive: true, onClick: () => onRemove(variant.id) }] : []),
  ], [canRemove, onPrint, onRemove, onToggleExpand, printable, t, variant.id]);

  return (
    <div data-variant-row={variant.id} className={cn(kindColumn ? ROW_GRID_KIND : ROW_GRID, "border-b py-1.5", selected && "bg-muted/50")}>
      <div className="flex justify-center">
        <Checkbox checked={selected} onCheckedChange={(checked) => onSelect([variant.id], checked === true)} aria-label={r("select", { name })} />
      </div>
      <VariantImagePicker
        value={variant.imageId}
        images={images}
        invalid={Boolean(photoError)}
        label={t("photoFor", { name })}
        onChange={(imageId) => change({ imageId: imageId ?? null })}
      />
      <div className={cn("min-w-0", depth === 1 && "pl-3")}>
        {/* Only the name is the button, so its focus ring hugs the text. */}
        <button
          type="button"
          onClick={() => onToggleExpand(variant.id)}
          aria-expanded={expanded}
          aria-label={t("moreFieldsFor", { name })}
          title={name}
          className="inline-flex max-w-full items-center gap-1 rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{label}</span>
          {expanded ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" /> : null}
        </button>
        <div className="flex min-w-0 items-center gap-2 text-body text-muted-foreground">
          <IdText value={variant.sku} copy className="min-w-0" />
          {/* The price after the variant's discount, compact; the full sentence is its name and tooltip. */}
          {sale !== null ? (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title={t("afterDiscount", { amount: money.whole(sale) })}>
              <Tag aria-hidden="true" className="size-3.5" />
              <span aria-hidden="true">{money.whole(sale)}</span>
              <span className="sr-only">{t("afterDiscount", { amount: money.whole(sale) })}</span>
            </span>
          ) : null}
        </div>
        {photoError ? <p className="text-body text-destructive">{photoError}</p> : null}
      </div>
      <div className="col-span-2 col-start-3 row-start-2 grid grid-cols-2 gap-2 pt-2 md:contents">
        <div className="min-w-0">
          <span className="block text-body text-muted-foreground md:hidden">{t("price")}</span>
          <MoneyInput
            currencyCode={money.code}
            prefix={money.symbol}
            value={variant.price}
            data-cell="price"
            aria-invalid={Boolean(priceError)}
            aria-label={t("priceFor", { name })}
            onValueChange={(price) => change({ price: price ?? Number.NaN })}
          />
          {priceError ? <p className="text-body text-destructive">{priceError}</p> : null}
        </div>
        <div className="min-w-0">
          <span className="block text-body text-muted-foreground md:hidden">{t("quantity")}</span>
          {variant.trackInventory ? (
            <InventoryQuantityInput
              cell="stock"
              ariaLabel={t("quantityFor", { name })}
              invalid={Boolean(stockError)}
              value={variant.stock}
              committed={committed}
              onChange={(stock) => change({ stock })}
            />
          ) : (
            <p className="py-2 text-body text-muted-foreground">{t("notTracked")}</p>
          )}
          {stockError ? <p className="text-body text-destructive">{stockError}</p> : null}
        </div>
        {kindColumn ? (
          <div className="col-span-2 min-w-0 md:col-span-1">
            <span className="block text-body text-muted-foreground md:hidden">{t("fulfilment")}</span>
            <KindSelect
              value={variant.fulfillmentKind === "service" ? "service" : "physical"}
              label={t("fulfilmentFor", { name })}
              onChange={(fulfillmentKind) => change({ fulfillmentKind })}
            />
          </div>
        ) : null}
      </div>
      <div className={cn("col-start-4 row-start-1 flex justify-end", kindColumn ? "md:col-start-7" : "md:col-start-6")}>
        <DataTableRowActions extraActions={actions} menuLabel={r("actionsFor", { name })} />
      </div>
      {expanded ? (
        <div className="col-span-full mt-2 rounded-md border bg-muted/30 p-3">
          <AdvancedSkuFields variant={variant} name={name} issueFor={issueFor} onChange={change} />
        </div>
      ) : null}
    </div>
  );
});

type GroupRowProps = {
  group: VariantGroup;
  open: boolean;
  images: ProductSkuImageChoice[];
  money: Money;
  selectedCount: number;
  kindColumn: boolean;
  onToggle: (valueId: string) => void;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onChangeMany: VariantTableProps["onChangeMany"];
};

/** A group re-renders only when one of its own variants (or its state) changed. */
function sameGroupRow(previous: GroupRowProps, next: GroupRowProps): boolean {
  return previous.open === next.open
    && previous.images === next.images
    && previous.money === next.money
    && previous.selectedCount === next.selectedCount
    && previous.kindColumn === next.kindColumn
    && previous.onChangeMany === next.onChangeMany
    && previous.group.label === next.group.label
    && previous.group.variants.length === next.group.variants.length
    && previous.group.variants.every((variant, index) => variant === next.group.variants[index]);
}

const GroupRow = React.memo(function GroupRow({ group, open, images, money, selectedCount, kindColumn, onToggle, onSelect, onChangeMany }: GroupRowProps) {
  const t = useMessages(productMessages);
  const ids = group.variants.map((variant) => variant.id);
  const tracked = group.variants.filter((variant) => variant.trackInventory);
  const same = <T,>(values: T[]): T | undefined => (values.every((value) => value === values[0]) ? values[0] : undefined);
  const prices = group.variants.map((variant) => variant.price).filter(Number.isFinite);
  const commonPrice = same(group.variants.map((variant) => variant.price));
  const commonStock = same(tracked.map((variant) => variant.stock));
  const commonImage = same(group.variants.map((variant) => variant.imageId));
  // The field already shows the symbol: the range reads as plain numbers.
  const range = prices.length ? `${formatNumber(Math.min(...prices))}–${formatNumber(Math.max(...prices))}` : undefined;
  const allSelected = selectedCount === ids.length;
  return (
    <div className={cn(kindColumn ? ROW_GRID_KIND : ROW_GRID, "border-b bg-muted/30 py-2")}>
      <div className="flex justify-center">
        <Checkbox
          checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
          onCheckedChange={() => onSelect(ids, !allSelected)}
          aria-label={t("selectGroup", { name: group.label })}
        />
      </div>
      <VariantImagePicker
        value={commonImage}
        images={images}
        label={t("photoForGroup", { name: group.label })}
        onChange={(imageId) => {
          if (imageId !== undefined) onChangeMany(new Set(ids), { imageId });
        }}
      />
      <button
        type="button"
        onClick={() => onToggle(group.valueId)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 justify-self-start rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
        <span className="truncate">{group.label}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{t("variantCount", { count: group.variants.length })}</span>
      </button>
      <div className="col-span-2 col-start-3 row-start-2 grid grid-cols-2 gap-2 pt-2 md:contents">
        <MoneyInput
          currencyCode={money.code}
          prefix={money.symbol}
          value={commonPrice ?? null}
          placeholder={commonPrice === undefined ? t("mixedValues") : undefined}
          title={commonPrice === undefined ? range : undefined}
          data-cell="price"
          aria-label={t("priceForGroup", { name: group.label })}
          onValueChange={(price) => {
            if (price !== null && Number.isFinite(price)) onChangeMany(new Set(ids), { price: Math.max(0, price) });
          }}
        />
        {tracked.length > 0 ? (
          <NumberInput
            integer
            value={commonStock ?? null}
            placeholder={commonStock === undefined ? t("mixedValues") : undefined}
            data-cell="stock"
            aria-label={t("quantityForGroup", { name: group.label })}
            onValueChange={(stock) => {
              if (stock !== null && Number.isInteger(stock)) onChangeMany(new Set(tracked.map((variant) => variant.id)), { stock: Math.max(0, stock) });
            }}
          />
        ) : (
          <p className="py-2 text-body text-muted-foreground">{t("notTracked")}</p>
        )}
        {kindColumn ? (
          <div className="col-span-2 min-w-0 md:col-span-1">
            <KindSelect
              value={same(group.variants.map((variant): EditableKind => (variant.fulfillmentKind === "service" ? "service" : "physical")))}
              label={t("fulfilmentForGroup", { name: group.label })}
              onChange={(fulfillmentKind) => onChangeMany(new Set(ids), { fulfillmentKind })}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}, sameGroupRow);

/** Physical (ship or pickup) or a service, for one row or a whole group ("Mixed" until chosen). */
function KindSelect({ value, label, onChange }: {
  value: EditableKind | undefined;
  label: string;
  onChange: (kind: EditableKind) => void;
}) {
  const t = useMessages(productMessages);
  return (
    <NativeSelect
      value={value ?? ""}
      aria-label={label}
      onValueChange={(next) => {
        if (next === "physical" || next === "service") onChange(next);
      }}
    >
      {value === undefined ? <option value="" disabled>{t("mixedValues")}</option> : null}
      <option value="physical">{t("fulfilmentPhysicalShort")}</option>
      <option value="service">{t("fulfilmentServiceShort")}</option>
    </NativeSelect>
  );
}

function BulkBar({ count, allSelected, printableIds, printingDisabled, wide, panel, onPanel, onClear, onPrint, onRemove }: {
  count: number;
  /** The table has a Fulfilment column. */
  wide: boolean;
  allSelected: boolean;
  printableIds: string[];
  printingDisabled: boolean;
  panel: BulkPanel;
  onPanel: (panel: BulkPanel) => void;
  onClear: () => void;
  onPrint: (ids: readonly string[]) => void;
  onRemove: () => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const toggle = (next: BulkPanel) => onPanel(panel === next ? null : next);
  return (
    <div className={cn("col-span-3 col-start-2 flex min-w-0 flex-wrap items-center gap-1 py-1", wide ? "md:col-span-6" : "md:col-span-5")}>
      <strong className="font-medium text-foreground">{r("selected", { count })}</strong>
      <Button type="button" variant="link" size="sm" onClick={onClear}>{t("clearSelection")}</Button>
      <Button type="button" variant={panel === "price" ? "secondary" : "outline"} size="sm" aria-pressed={panel === "price"} onClick={() => toggle("price")}>
        {t("editPrices")}
      </Button>
      <Button type="button" variant={panel === "stock" ? "secondary" : "outline"} size="sm" aria-pressed={panel === "stock"} onClick={() => toggle("stock")}>
        {t("editQuantities")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {r("moreActions")}
            <ChevronDown aria-hidden="true" className="ml-1 size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => toggle("sku")}>{t("setSkus")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => toggle("photo")}>{t("setPhoto")}</DropdownMenuItem>
          <DropdownMenuItem disabled={printableIds.length === 0} onSelect={() => onPrint(printableIds)}>
            <Printer aria-hidden="true" /> {printingDisabled ? t("saveBeforePrinting") : t("printLabels")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={allSelected}
            aria-describedby={allSelected ? "variant-bulk-keep-one" : undefined}
            variant="destructive"
            onSelect={onRemove}
          >
            <Trash2 aria-hidden="true" /> {t("stopSelling")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function BulkPanelRow({ panel, options, images, money, productName, selectedVariants, onApply, onCancel }: {
  panel: Exclude<BulkPanel, null>;
  options: DraftOption[];
  images: ProductSkuImageChoice[];
  money: Money;
  productName: string;
  selectedVariants: DraftVariant[];
  onApply: (patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>)) => void;
  onCancel: () => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [price, setPrice] = React.useState<number | null>(null);
  const [stock, setStock] = React.useState<number | null>(null);
  const [imageId, setImageId] = React.useState<string | null | undefined>(undefined);
  const [pattern, setPattern] = React.useState(() => defaultSkuPattern(productName, options));
  const count = selectedVariants.length;
  const trackedCount = selectedVariants.filter((variant) => variant.trackInventory).length;
  const preview = selectedVariants[0] ? skuFromPattern(pattern, options, selectedVariants[0]) : "";
  const inputId = React.useId();

  let field: React.ReactNode;
  let ready = false;
  let apply: () => void = () => {};
  if (panel === "price") {
    ready = price !== null && Number.isFinite(price) && price >= 0;
    apply = () => onApply({ price: price! });
    field = (
      <MoneyInput
        id={inputId}
        autoFocus
        currencyCode={money.code}
        prefix={money.symbol}
        value={price}
        onValueChange={setPrice}
        className="w-36"
      />
    );
  } else if (panel === "stock") {
    ready = stock !== null && Number.isInteger(stock) && stock >= 0 && trackedCount > 0;
    apply = () => onApply((variant) => (variant.trackInventory ? { stock: stock! } : {}));
    field = <NumberInput id={inputId} autoFocus integer value={stock} onValueChange={setStock} className="w-28" />;
  } else if (panel === "sku") {
    ready = preview.length >= 3;
    apply = () => onApply((variant) => ({ sku: skuFromPattern(pattern, options, variant) }));
    field = (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input id={inputId} autoFocus value={pattern} onChange={(event) => setPattern(event.target.value)} />
        <div className="flex flex-wrap gap-1">
          {options.map((option) => (
            <Button key={option.id} type="button" variant="ghost" size="sm" onClick={() => setPattern((current) => `${current}-{${option.name.trim()}}`)}>
              {t("insertOption", { name: option.name.trim() })}
            </Button>
          ))}
        </div>
        <p className="text-body text-muted-foreground">
          {t("skuPatternHint", { example: defaultSkuPattern(productName, options) })}{" "}
          {preview ? t("skuPreview", { sku: preview }) : null}
        </p>
      </div>
    );
  } else {
    ready = imageId !== undefined;
    apply = () => onApply({ imageId: imageId ?? null });
    field = <VariantImagePicker value={imageId} images={images} label={t("photoForSelected")} allowNoChange onChange={setImageId} />;
  }

  const label = panel === "price" ? t("newPriceFor", { count })
    : panel === "stock" ? t("newQuantityFor", { count: trackedCount })
      : panel === "sku" ? t("skuPattern")
        : t("photoForSelected");
  return (
    // Inside the product form, so no form of its own: Enter applies the panel and stops here.
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-end gap-2 border-b bg-muted/30 px-2 py-2"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (ready) apply();
        }
        event.stopPropagation();
      }}
    >
      <label htmlFor={inputId} className="w-full text-body text-muted-foreground">{label}</label>
      {field}
      <Button type="button" size="sm" disabled={!ready} onClick={apply}>{t("apply")}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{r("cancel")}</Button>
    </div>
  );
}

function NotForSaleList({ combinations, valueLabel, onRestore, onRestoreAll }: {
  combinations: string[][];
  valueLabel: ReadonlyMap<string, string>;
  onRestore: (valueIds: string[]) => void;
  onRestoreAll: () => void;
}) {
  const t = useMessages(productMessages);
  return (
    <div className="border-y">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-2 py-2">
        <p className="text-body text-muted-foreground">{t("notForSaleHint")}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRestoreAll}>{t("turnAllOn")}</Button>
      </div>
      <ul className="divide-y">
        {combinations.map((valueIds) => {
          const label = valueIds.map((id) => valueLabel.get(id) ?? "?").join(" / ");
          return (
            <li key={combinationKey(valueIds)} className="flex min-h-11 items-center justify-between gap-3 px-2 py-1.5 text-body">
              <span className="truncate text-muted-foreground">{label}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => onRestore(valueIds)} aria-label={`${t("turnOn")}: ${label}`}>
                {t("turnOn")}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
