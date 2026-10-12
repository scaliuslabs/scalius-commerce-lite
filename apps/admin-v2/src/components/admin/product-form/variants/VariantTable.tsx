// Shopify's variant table: one line per variant (photo, name with its SKU,
// price, quantity, a "…" menu), grouped by an option with group-level edits,
// bulk edits on the selection, and arrow keys between the price and quantity
// fields. Rows are memoised, so typing re-renders only the row being edited.
import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Blocks, ChevronDown, ChevronRight, Database, PenLine, Printer, Search, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Inset, ReadOnlyValue } from "~/components/ui/field";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CostInput, MoneyInput } from "@/components/admin/shared/MoneyInput";
import { IdText } from "~/components/admin/data-table/cells";
import { DataTableRowActions, type ExtraAction } from "~/components/admin/data-table/DataTableRowActions";
import { IndexPager } from "~/components/admin/data-table/DataTablePagination";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, readSavedPageSize, writeSavedPageSize } from "~/lib/list-helpers";
import { cn } from "@scalius/shared/utils";
import { isWholeUnitIncrement, resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { useCurrency } from "@/hooks/use-currency";
import { formatNumber, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { customFieldMessages } from "~/i18n/custom-fields";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";
import { appActionKey, useAppActionRunner } from "~/components/admin/apps/ui/AppActions";
import { AppResourceCards } from "~/components/admin/apps/ui/AppResourceCards";
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
import { pageCount, pageEntries, pageOfVariant, variantEntries } from "./variant-table-paging";
import { useProductKindRules, isDigitalSku } from "../product-kind-rules";
import { DigitalStockCell } from "../DigitalStock";
import { formatMargin } from "~/components/admin/inventory/cost-fields";
import { costMargin, costProblem } from "~/lib/api-query-options/inventory-costs";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  AdvancedSkuFields,
  InventoryQuantityInput,
  VariantImagePicker,
  type IncomingUnits,
  type IssueFor,
  type StockElsewhere,
} from "./variant-fields";

// Keep the variant dialog off the editor's first download, like the product's
// Custom data card. It stays mounted once loaded so closing preserves focus.
const VariantCustomFieldsDialog = React.lazy(() =>
  import("~/components/admin/custom-fields/CustomFieldsCard").then((module) => ({ default: module.VariantCustomFieldsDialog })),
);

/** Phone: select, photo, name, menu (price and quantity below). Wider: one line with every column. */
const ROW_GRID = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_6rem_2.25rem]";
/** The same rows with a Fulfilment column, shown only while variants differ (physical vs service). */
const ROW_GRID_KIND = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_6rem_7.5rem_2.25rem]";
/** Without a Quantity column: kinds that never track quantity (gift cards). */
const ROW_GRID_NO_QUANTITY = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_2.25rem]";
const ROW_GRID_NO_QUANTITY_KIND = "grid grid-cols-[2rem_2.75rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 md:grid-cols-[2rem_2.75rem_minmax(0,1fr)_7.5rem_7.5rem_2.25rem]";

/** The table's columns: the grid, where the row menu sits, and how wide the bulk bar is. */
type RowLayout = { grid: string; actions: string; bulkSpan: string; kind: boolean; quantity: boolean };
const ROW_LAYOUTS: Record<"base" | "kind" | "noQuantity" | "noQuantityKind", RowLayout> = {
  base: { grid: ROW_GRID, actions: "col-start-4 md:col-start-6", bulkSpan: "md:col-span-5", kind: false, quantity: true },
  kind: { grid: ROW_GRID_KIND, actions: "col-start-4 md:col-start-7", bulkSpan: "md:col-span-6", kind: true, quantity: true },
  noQuantity: { grid: ROW_GRID_NO_QUANTITY, actions: "col-start-4 md:col-start-5", bulkSpan: "md:col-span-4", kind: false, quantity: false },
  noQuantityKind: { grid: ROW_GRID_NO_QUANTITY_KIND, actions: "col-start-4 md:col-start-6", bulkSpan: "md:col-span-5", kind: true, quantity: false },
};
function rowLayout(kind: boolean, quantity: boolean): RowLayout {
  if (quantity) return kind ? ROW_LAYOUTS.kind : ROW_LAYOUTS.base;
  return kind ? ROW_LAYOUTS.noQuantityKind : ROW_LAYOUTS.noQuantity;
}
type EditableKind = "physical" | "service";

type Money = ReturnType<typeof useCurrency> & {
  /** "৳12,692": a customer-facing amount without paisa when the currency is paid in whole units. */
  whole: (amount: number) => string;
};
type BulkPanel = "price" | "stock" | "sku" | "photo" | "cost" | null;

/** The variants' costs per item, kept by the page (a cost is not part of the variant draft). */
export interface VariantCosts {
  of: (id: string) => number | null;
  change: (ids: ReadonlySet<string>, cost: number | null) => void;
}

/**
 * Past this many variants the groups open closed, as in Shopify: a product
 * with 150 variants opens with its 15 group rows, not 150 rows of fields (each
 * row mounts a photo picker, a checkbox and two inputs).
 */
export const GROUPS_OPEN_LIMIT = 30;

export type VariantTableProps = {
  readOnly?: boolean;
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
  /** Stores with several locations: the quantity column edits the default location ("Quantity at Main location"). */
  quantityLabel?: string;
  /** Stores with several locations: each SKU's units held elsewhere (the rows' quantities exclude them). */
  stockElsewhere?: ReadonlyMap<string, StockElsewhere>;
  /** Cost per item for each variant, where the page edits costs. */
  costs?: VariantCosts | null;
  /** Units on their way to each SKU (open purchase orders, transfers in transit). */
  incoming?: ReadonlyMap<string, IncomingUnits>;
  /** The saved product: digital rows show their licence keys or files instead of a quantity. */
  productId?: string;
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
function moveBetweenRows(event: React.KeyboardEvent<HTMLElement>, onEdge?: (cell: string, step: 1 | -1) => boolean) {
  const target = event.target as HTMLInputElement;
  const cell = target.dataset?.cell;
  if (!cell || event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey) ? 1
    : event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 0;
  if (step === 0) return;
  // Repeated headers keep group edits available without inserting another bulk-edit
  // stop into the sequence of SKU fields. Their own Down key starts at the first SKU.
  const cells = [...event.currentTarget.querySelectorAll<HTMLInputElement>(`input[data-cell="${cell}"]`)]
    .filter((input) => !input.closest("[data-repeated-group]"));
  const next = cells[cells.indexOf(target) + step];
  if (!next) {
    // Continue to the next logical field, skipping pages without that column.
    if (onEdge?.(cell, step as 1 | -1)) event.preventDefault();
    return;
  }
  event.preventDefault();
  next.focus();
  next.select();
}

export function VariantTable(props: VariantTableProps) {
  const { options, variants, missingCombinations, readOnly = false } = props;
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const currency = useCurrency();
  const { code, symbol, fmt, salePrice, priceIncrementMinor } = currency;
  const money = React.useMemo(() => ({
    code, symbol, fmt, salePrice,
    whole: (amount: number) => (isWholeUnitIncrement(code, resolvePriceIncrementMinor(code, priceIncrementMinor)) ? `${symbol}${formatNumber(Math.round(amount))}` : fmt(amount)),
  }) as Money, [code, symbol, fmt, salePrice, priceIncrementMinor]);

  // The product kind decides the columns: a gift card tracks no quantity (and has no cost per item).
  const kindRules = useProductKindRules();
  const { showInventory, giftCard } = kindRules;
  const costs = giftCard ? null : props.costs ?? null;
  const layout = rowLayout(Boolean(props.fulfilmentColumn), showInventory);
  const kindColumn = layout.kind;
  const grid = layout.grid;
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<"all" | "notForSale">("all");
  const [groupAxis, setGroupAxis] = React.useState(0);
  const [groupsStartOpen] = React.useState(() => variants.length <= GROUPS_OPEN_LIMIT);
  // Groups the merchant opened or closed against that start.
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [panel, setPanel] = React.useState<BulkPanel>(null);
  const tableRef = React.useRef<HTMLDivElement>(null);
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(() => readSavedPageSize("product-variants") ?? DEFAULT_PAGE_SIZE);
  // A revealed variant waiting for its page to show.
  const [revealTarget, setRevealTarget] = React.useState<string | null>(null);
  // The field that keyboard focus moves to once the next page shows.
  const pendingFocus = React.useRef<{ cell: string; rowSelector: string } | null>(null);

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
  const filteredMissing = React.useMemo(() => {
    const needle = normalized(query);
    return needle ? missingCombinations.filter((ids) => normalized(ids.map((id) => valueLabel.get(id) ?? "").join(" ")).includes(needle)) : missingCombinations;
  }, [missingCombinations, query, valueLabel]);
  const groups = React.useMemo(
    () => (grouped ? groupVariants(options, filtered, groupAxis) : []),
    [filtered, groupAxis, grouped, options],
  );
  // The lines the table may show (a search opens every group). Only one page mounts;
  // selection, bulk and group edits still cover every variant.
  const entries = React.useMemo(
    () => variantEntries(filtered, grouped ? groups : null, (valueId) => Boolean(query) || groupsStartOpen !== toggled.has(valueId)),
    [filtered, grouped, groups, groupsStartOpen, query, toggled],
  );
  const entryCount = view === "notForSale" ? filteredMissing.length : entries.length;
  const pages = pageCount(entryCount, pageSize);
  const pageIndex = Math.min(page, pages - 1);
  if (page !== pageIndex) setPage(pageIndex);
  const pageItems = React.useMemo(() => pageEntries(entries, pageIndex, pageSize), [entries, pageIndex, pageSize]);
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
    if (missingCombinations.length === 0 && view !== "all") {
      setView("all");
      setPage(0);
    }
  }, [missingCombinations.length, view]);
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
    setRevealTarget(target.variantId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.nonce]);
  // Once its group is open and the search is cleared: turn to its page, then bring it into view.
  React.useEffect(() => {
    if (!revealTarget) return;
    const at = pageOfVariant(entries, revealTarget, pageSize);
    if (at >= 0 && at !== pageIndex) {
      setPage(at);
      return;
    }
    setRevealTarget(null);
    if (at < 0) return;
    requestAnimationFrame(() => {
      const shown = tableRef.current?.querySelector<HTMLElement>(`[data-variant-row="${CSS.escape(revealTarget)}"]`);
      shown?.scrollIntoView({ block: "center" });
      shown?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
    });
  }, [entries, pageIndex, pageSize, revealTarget]);

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
  const onCostChange = useStableCallback((id: string, cost: number | null) => costs?.change(new Set([id]), cost));
  const onEdge = useStableCallback((cell: string, step: 1 | -1) => {
    const tracked = (variant: DraftVariant) => variant.trackInventory && !isDigitalSku(kindRules, variant);
    for (let index = step > 0 ? (pageIndex + 1) * pageSize : pageIndex * pageSize - 1;
      index >= 0 && index < entries.length; index += step) {
      const entry = entries[index]!;
      if (cell === "stock" && !(entry.kind === "row" ? tracked(entry.variant) : entry.group.variants.some(tracked))) continue;
      pendingFocus.current = {
        cell,
        rowSelector: entry.kind === "row"
          ? `[data-variant-row="${CSS.escape(entry.variant.id)}"]`
          : `[data-variant-group="${CSS.escape(entry.group.valueId)}"]`,
      };
      setPage(Math.floor(index / pageSize));
      return true;
    }
    return false;
  });
  React.useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const field = tableRef.current?.querySelector<HTMLInputElement>(`${pending.rowSelector} input[data-cell="${pending.cell}"]`);
    field?.focus();
    field?.select();
  }, [pageIndex]);
  // A saved SKU's custom data, edited in its own dialog (the detail panel unmounts when closed).
  const canEditProducts = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const [customDataFor, setCustomDataFor] = React.useState<{ id: string; sku: string } | null>(null);
  const onCustomData = useStableCallback((id: string) => {
    const variant = variants.find((item) => item.id === id);
    if (variant) setCustomDataFor({ id, sku: variant.sku || props.nameOf(variant) });
  });
  // Apps' actions for one saved SKU, in its row menu (one runner and its dialogs for the table).
  const appActions = useAppActionRunner("variant", false);
  const appActionItems = React.useMemo<AppRowAction[]>(
    () => appActions.entries.map((entry) => ({ key: appActionKey(entry), label: entry.action.label, destructive: entry.action.destructive })),
    [appActions.entries],
  );
  const onAppAction = useStableCallback((key: string, id: string) => {
    const entry = appActions.entries.find((item) => appActionKey(item) === key);
    if (entry) appActions.start(entry, [id]);
  });

  const visibleIds = filtered.map((variant) => variant.id);
  const selectedCount = selected.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));
  const canRemoveAny = variants.length > 1;

  const row = (variant: DraftVariant, depth: 0 | 1) => (
    <VariantRow
      key={variant.id}
      readOnly={readOnly}
      variant={variant}
      name={props.nameOf(variant)}
      label={labelOf(variant)}
      depth={depth}
      selected={selected.has(variant.id)}
      expanded={props.expandedId === variant.id}
      issue={props.issue?.variantId === variant.id ? props.issue : null}
      committed={props.committedByVariantId.get(variant.id) ?? 0}
      quantityLabel={props.quantityLabel}
      elsewhere={props.stockElsewhere?.get(variant.id)}
      incoming={props.incoming?.get(variant.id)}
      digital={isDigitalSku(kindRules, variant)}
      productId={props.productId}
      cost={costs ? costs.of(variant.id) : undefined}
      images={props.images}
      money={money}
      canRemove={!readOnly && canRemoveAny}
      printable={!props.printingDisabled && variant.id.startsWith("var_")}
      customData={variant.id.startsWith("var_")}
      layout={layout}
      onChange={onChange}
      onCostChange={onCostChange}
      onSelect={onSelect}
      onToggleExpand={onToggleExpand}
      onRemove={onRemove}
      onPrint={onPrint}
      onCustomData={onCustomData}
      appActions={!readOnly && variant.id.startsWith("var_") ? appActionItems : NO_APP_ACTIONS}
      onAppAction={onAppAction}
    />
  );

  return (
    <div className="border-t">
      {/* Toolbar: how the rows are grouped, which rows show, and a search. */}
      <div className="flex flex-wrap items-center gap-2 py-2">
        {view === "all" && options.length >= 2 ? (
          <label className="flex items-center gap-2 text-body text-muted-foreground">
            {t("groupBy")}
            <SearchableSelect
              value={String(grouped ? groupAxis : -1)}
              onValueChange={(value) => {
                setGroupAxis(Number(value) < 0 ? options.length : Number(value));
                setPage(0);
              }}
              triggerClassName="w-auto min-w-28"
              options={[
                ...options.map((option, index) => ({ value: String(index), label: option.name.trim() || t("optionNumber", { number: index + 1 }) })),
                { value: "-1", label: t("groupByNone") },
              ]}
            />
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
                onClick={() => {
                  setView(key);
                  setPage(0);
                }}
              >
                {key === "all"
                  ? t("showAllVariants", { count: variants.length })
                  : t("showNotForSale", { count: missingCombinations.length })}
              </Button>
            ))}
          </div>
        ) : null}
        <label className="relative ms-auto">
          <span className="sr-only">{t("findVariant")}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          {/* eslint-disable-next-line shadcn/no-restyle -- room for the inline search icon, as in the list toolbar */}
          <Input type="search" className="w-44 ps-8" value={query} onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }} placeholder={t("findVariant")} />
        </label>
      </div>

      {view === "notForSale" ? (
        <NotForSaleList
          readOnly={readOnly}
          combinations={filteredMissing.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)}
          valueLabel={valueLabel}
          onRestore={props.onRestoreCombination}
          onRestoreAll={props.onRestoreAll}
        />
      ) : (
        <div ref={tableRef} onKeyDown={(event) => moveBetweenRows(event, onEdge)}>
          {/* The header turns into the bulk bar while rows are selected, so the table never shifts. */}
          <div className={cn(grid, "min-h-11 border-y bg-muted/50 text-body text-muted-foreground")}>
            <div className="flex justify-center">
              {!readOnly ? <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                onCheckedChange={() => onSelect(visibleIds, !allVisibleSelected)}
                aria-label={r("selectAll")}
              /> : null}
            </div>
            {!readOnly && selectedCount > 0 ? (
              <BulkBar
                count={selectedCount}
                allSelected={selectedCount >= variants.length}
                printableIds={props.printingDisabled ? [] : [...selected].filter((id) => id.startsWith("var_"))}
                printingDisabled={props.printingDisabled}
                canEditCosts={costs !== null}
                layout={layout}
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
                {layout.quantity ? <span className="hidden font-medium md:block">{props.quantityLabel ?? t("quantity")}</span> : null}
                {kindColumn ? <span className="hidden font-medium md:block">{t("fulfilment")}</span> : null}
                <span className={layout.actions}><span className="sr-only">{r("actions")}</span></span>
              </>
            )}
          </div>
          {!readOnly && selectedCount > 0 && panel ? (
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
              onCostApply={(cost) => {
                costs?.change(selected, cost);
                setPanel(null);
              }}
              onCancel={() => setPanel(null)}
            />
          ) : null}
          {!readOnly && selectedCount >= variants.length ? (
            <p id="variant-bulk-keep-one" className="border-b px-2 py-1.5 text-body text-muted-foreground">{t("keepOneVariant")}</p>
          ) : null}

          {pageItems.map((entry) => (entry.kind === "group" ? (
            <GroupRow
              readOnly={readOnly}
              key={`group:${entry.group.valueId}`}
              group={entry.group}
              open={entry.open}
              repeated={entry.repeated}
              images={props.images}
              money={money}
              selectedCount={entry.group.variants.filter((variant) => selected.has(variant.id)).length}
              layout={layout}
              onToggle={onToggleGroup}
              onSelect={onSelect}
              onChangeMany={props.onChangeMany}
            />
          ) : row(entry.variant, entry.depth)))}
        </div>
      )}
      {entryCount === 0 ? <div className="px-3 py-6 text-center text-body text-muted-foreground">{r("noResults")}</div> : null}
      {entryCount > 0 && (pages > 1 || pageSize !== DEFAULT_PAGE_SIZE) ? (
        <IndexPager
          label={view === "all" && grouped
            ? r("page", { page: formatNumber(pageIndex + 1), pages: formatNumber(pages) })
            : r("showing", {
                start: formatNumber(pageIndex * pageSize + 1),
                end: formatNumber(Math.min((pageIndex + 1) * pageSize, entryCount)),
                total: formatNumber(entryCount),
              })}
          navLabel={r("pagination")}
          pageSize={{
            value: pageSize,
            options: PAGE_SIZE_OPTIONS,
            onChange: (size) => {
              writeSavedPageSize("product-variants", size);
              setPageSize(size);
              setPage(0);
            },
          }}
          canPrevious={pageIndex > 0}
          canNext={pageIndex < pages - 1}
          onPrevious={() => setPage(pageIndex - 1)}
          onNext={() => setPage(pageIndex + 1)}
        />
      ) : null}
      <React.Suspense fallback={null}>
        <VariantCustomFieldsDialog
          variantId={customDataFor?.id ?? null}
          sku={customDataFor?.sku ?? ""}
          canEdit={!readOnly && canEditProducts}
          open={customDataFor !== null}
          onOpenChange={(open) => (open ? undefined : setCustomDataFor(null))}
        />
      </React.Suspense>
      {!readOnly ? appActions.dialogs : null}
    </div>
  );
}

/** An app's action in a saved SKU's row menu. */
type AppRowAction = { key: string; label: string; destructive: boolean };
const NO_APP_ACTIONS: readonly AppRowAction[] = [];

type VariantRowProps = {
  readOnly: boolean;
  variant: DraftVariant;
  name: string;
  label: string;
  depth: 0 | 1;
  selected: boolean;
  expanded: boolean;
  issue: DraftIssue | null;
  committed: number;
  quantityLabel?: string;
  elsewhere?: StockElsewhere;
  incoming?: IncomingUnits;
  /** A digital SKU: its keys or files stand where a quantity would (never typed in). */
  digital: boolean;
  productId?: string;
  /** The variant's cost per item (null: none); undefined where costs aren't edited. */
  cost: number | null | undefined;
  images: ProductSkuImageChoice[];
  money: Money;
  canRemove: boolean;
  printable: boolean;
  layout: RowLayout;
  onChange: (id: string, patch: Partial<DraftVariant>) => void;
  onCostChange: (id: string, cost: number | null) => void;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onToggleExpand: (id: string) => void;
  onRemove: (id: string) => void;
  onPrint: (ids: readonly string[]) => void;
  /** A saved SKU: its custom data can be edited. */
  customData: boolean;
  onCustomData: (id: string) => void;
  /** Apps' actions for this saved SKU (empty for new rows). */
  appActions: readonly AppRowAction[];
  onAppAction: (key: string, id: string) => void;
};

const VariantRow = React.memo(function VariantRow({
  readOnly, variant, name, label, depth, selected, expanded, issue, committed, quantityLabel, elsewhere, incoming, digital, productId, cost, images, money, canRemove,
  printable, customData, layout, onChange, onCostChange, onSelect, onToggleExpand, onRemove, onPrint, onCustomData, appActions, onAppAction,
}: VariantRowProps) {
  const kindColumn = layout.kind;
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const cf = useMessages(customFieldMessages);
  const errorOf = (field: DraftIssue["field"]) => (issue && issue.field === field ? issue.message : undefined);
  const issueFor: IssueFor = (_variantId, field) => errorOf(field);
  const priceError = errorOf("price");
  const stockError = errorOf("stock");
  const photoError = errorOf("photo");
  const sale = Number.isFinite(variant.price) && !errorOf("discount") ? money.salePrice(variant.price, variant) : null;
  const change = (patch: Partial<DraftVariant>) => onChange(variant.id, patch);
  // Profit and margin of what the customer pays (after the variant's discount).
  const customerPays = Number.isFinite(variant.price) ? sale ?? variant.price : null;
  const margin = cost === undefined ? null : costMargin(customerPays, cost, getDecimalPlaces(money.code));
  const actions = React.useMemo<ExtraAction[]>(() => [
    ...(!readOnly ? [{ label: t("editDetails"), icon: PenLine, onClick: () => onToggleExpand(variant.id) }] : []),
    ...(printable ? [{ label: t("printLabels"), icon: Printer, onClick: () => onPrint([variant.id]) }] : []),
    ...(customData ? [{ label: cf("variantAction"), icon: Database, onClick: () => onCustomData(variant.id) }] : []),
    ...appActions.map((action) => ({ label: action.label, icon: Blocks, destructive: action.destructive, onClick: () => onAppAction(action.key, variant.id) })),
    ...(canRemove ? [{ label: t("stopSelling"), icon: Trash2, destructive: true, onClick: () => onRemove(variant.id) }] : []),
  ], [readOnly, appActions, canRemove, cf, customData, onAppAction, onCustomData, onPrint, onRemove, onToggleExpand, printable, t, variant.id]);

  return (
    <div data-variant-row={variant.id} className={cn(layout.grid, "border-b py-1.5", selected && "bg-muted/50")}>
      <div className="flex justify-center">
        {!readOnly ? <Checkbox checked={selected} onCheckedChange={(checked) => onSelect([variant.id], checked === true)} aria-label={r("select", { name })} /> : null}
      </div>
      <VariantImagePicker
        readOnly={readOnly}
        value={variant.imageId}
        images={images}
        invalid={Boolean(photoError)}
        label={t("photoFor", { name })}
        onChange={(imageId) => change({ imageId: imageId ?? null })}
      />
      <div className={cn("min-w-0", depth === 1 && "ps-3")}>
        {/* Only the name is the button, so its focus ring hugs the text. */}
        <button
          type="button"
          onClick={() => onToggleExpand(variant.id)}
          aria-expanded={expanded}
          aria-label={t("moreFieldsFor", { name })}
          title={name}
          className="inline-flex h-11 max-w-full items-center gap-1 rounded-sm sm:h-9 text-start font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          {readOnly ? <p className="py-2 text-body tabular-nums"><span className="sr-only">{t("priceFor", { name })}: </span>{money.fmt(variant.price)}</p> : <MoneyInput
            currencyCode={money.code}
            value={variant.price}
            data-cell="price"
            aria-invalid={Boolean(priceError)}
            aria-label={t("priceFor", { name })}
            onValueChange={(price) => change({ price: price ?? Number.NaN })}
          />}
          {priceError ? <p className="text-body text-destructive">{priceError}</p> : margin ? (
            <p
              className={cn("text-end text-body tabular-nums", margin.margin !== null && margin.margin < 0 ? "text-destructive" : "text-muted-foreground")}
              title={t("profitAndMargin", { profit: money.fmt(margin.profit), margin: formatMargin(margin.margin) })}
            >
              {t("marginShort", { margin: formatMargin(margin.margin) })}
            </p>
          ) : null}
        </div>
        {layout.quantity ? (
          <div className="min-w-0">
            <span className="block text-body text-muted-foreground md:hidden">{quantityLabel ?? t("quantity")}</span>
            {digital ? (
              <DigitalStockCell productId={productId} variantId={variant.id} tracked={variant.trackInventory} />
            ) : variant.trackInventory ? (
              <InventoryQuantityInput
                readOnly={readOnly}
                cell="stock"
                ariaLabel={t("quantityFor", { name })}
                invalid={Boolean(stockError)}
                value={variant.stock}
                committed={committed}
                elsewhere={elsewhere}
                incoming={incoming}
                onChange={(stock) => change({ stock })}
              />
            ) : (
              <p className="py-2 text-body text-muted-foreground">{t("notTracked")}</p>
            )}
            {stockError ? <p className="text-body text-destructive">{stockError}</p> : null}
          </div>
        ) : null}
        {kindColumn ? (
          <div className="col-span-2 min-w-0 md:col-span-1">
            <span className="block text-body text-muted-foreground md:hidden">{t("fulfilment")}</span>
            <KindSelect
              readOnly={readOnly}
              value={variant.fulfillmentKind === "service" ? "service" : "physical"}
              label={t("fulfilmentFor", { name })}
              onChange={(fulfillmentKind) => change({ fulfillmentKind })}
            />
          </div>
        ) : null}
      </div>
      <div className={cn(layout.actions, "row-start-1 flex justify-end")}>
        {actions.length ? <DataTableRowActions extraActions={actions} menuLabel={r("actionsFor", { name })} /> : null}
      </div>
      {expanded ? (
        <Inset className="col-span-full mt-2">
          {readOnly ? <ReadOnlyValue label={t("variant")} value={name} className="mb-3" /> : null}
          <AdvancedSkuFields
            readOnly={readOnly}
            variant={variant}
            name={name}
            issueFor={issueFor}
            onChange={change}
            cost={cost === undefined ? null : { value: cost, customerPays, onChange: (next) => onCostChange(variant.id, next) }}
          />
          {/* Apps' cards for this saved SKU (`resource=variant`), inside the variant card. */}
          {customData ? <fieldset disabled={readOnly} className="min-w-0"><AppResourceCards target="variant" id={variant.id} inline className="mt-3 space-y-3" /></fieldset> : null}
        </Inset>
      ) : null}
    </div>
  );
});

type GroupRowProps = {
  readOnly: boolean;
  group: VariantGroup;
  open: boolean;
  repeated?: boolean;
  images: ProductSkuImageChoice[];
  money: Money;
  selectedCount: number;
  layout: RowLayout;
  onToggle: (valueId: string) => void;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  onChangeMany: VariantTableProps["onChangeMany"];
};

/** A group re-renders only when one of its own variants (or its state) changed. */
function sameGroupRow(previous: GroupRowProps, next: GroupRowProps): boolean {
  return previous.readOnly === next.readOnly
    && previous.open === next.open
    && previous.repeated === next.repeated
    && previous.images === next.images
    && previous.money === next.money
    && previous.selectedCount === next.selectedCount
    && previous.layout === next.layout
    && previous.onChangeMany === next.onChangeMany
    && previous.group.label === next.group.label
    && previous.group.variants.length === next.group.variants.length
    && previous.group.variants.every((variant, index) => variant === next.group.variants[index]);
}

const GroupRow = React.memo(function GroupRow({ readOnly, group, open, repeated, images, money, selectedCount, layout, onToggle, onSelect, onChangeMany }: GroupRowProps) {
  const kindColumn = layout.kind;
  const t = useMessages(productMessages);
  const ids = group.variants.map((variant) => variant.id);
  const kindRules = useProductKindRules();
  // Digital rows' stock is their keys or files: a group quantity never writes it.
  const tracked = group.variants.filter((variant) => variant.trackInventory && !isDigitalSku(kindRules, variant));
  const allDigital = group.variants.every((variant) => isDigitalSku(kindRules, variant));
  const same = <T,>(values: T[]): T | undefined => (values.every((value) => value === values[0]) ? values[0] : undefined);
  const prices = group.variants.map((variant) => variant.price).filter(Number.isFinite);
  const commonPrice = same(group.variants.map((variant) => variant.price));
  const commonStock = same(tracked.map((variant) => variant.stock));
  const commonImage = same(group.variants.map((variant) => variant.imageId));
  // The field already shows the symbol: the range reads as plain numbers.
  const range = prices.length ? `${formatNumber(Math.min(...prices))}–${formatNumber(Math.max(...prices))}` : undefined;
  const allSelected = selectedCount === ids.length;
  return (
    <div data-variant-group={group.valueId} data-repeated-group={repeated || undefined} className={cn(layout.grid, "border-b bg-muted/30 py-2")}>
      <div className="flex justify-center">
        {!readOnly ? <Checkbox
          checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
          onCheckedChange={() => onSelect(ids, !allSelected)}
          aria-label={t("selectGroup", { name: group.label })}
        /> : null}
      </div>
      <VariantImagePicker
        readOnly={readOnly}
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
        className="inline-flex max-w-full items-center gap-1 justify-self-start rounded-sm text-start font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
        <span className="truncate">{group.label}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{t("variantCount", { count: group.variants.length })}</span>
      </button>
      <div className="col-span-2 col-start-3 row-start-2 grid grid-cols-2 gap-2 pt-2 md:contents">
        {readOnly ? <p className="py-2 text-body tabular-nums"><span className="sr-only">{t("priceForGroup", { name: group.label })}: </span>{commonPrice === undefined ? prices.length ? `${money.fmt(Math.min(...prices))}–${money.fmt(Math.max(...prices))}` : "—" : money.fmt(commonPrice)}</p> : <MoneyInput
          currencyCode={money.code}
          value={commonPrice ?? null}
          placeholder={commonPrice === undefined ? t("mixedValues") : undefined}
          title={commonPrice === undefined ? range : undefined}
          data-cell="price"
          aria-label={t("priceForGroup", { name: group.label })}
          onValueChange={(price) => {
            if (price !== null && Number.isFinite(price)) onChangeMany(new Set(ids), { price: Math.max(0, price) });
          }}
        />}
        {!layout.quantity ? null : tracked.length > 0 ? (
          readOnly ? <p className="py-2 text-body tabular-nums"><span className="sr-only">{t("quantityForGroup", { name: group.label })}: </span>{commonStock === undefined ? t("mixedValues") : formatNumber(commonStock)}</p> : <NumberInput
            integer
            value={commonStock ?? null}
            placeholder={commonStock === undefined ? t("mixedValues") : undefined}
            data-cell="stock"
            aria-label={t("quantityForGroup", { name: group.label })}
            onValueChange={(stock) => {
              if (stock !== null && Number.isInteger(stock)) onChangeMany(new Set(tracked.map((variant) => variant.id)), { stock: Math.max(0, stock) });
            }}
          />
        ) : allDigital ? <span /> : (
          <p className="py-2 text-body text-muted-foreground">{t("notTracked")}</p>
        )}
        {kindColumn ? (
          <div className="col-span-2 min-w-0 md:col-span-1">
            <KindSelect
              readOnly={readOnly}
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
function KindSelect({ value, label, onChange, readOnly = false }: {
  readOnly?: boolean;
  value: EditableKind | undefined;
  label: string;
  onChange: (kind: EditableKind) => void;
}) {
  const t = useMessages(productMessages);
  if (readOnly) return <p className="py-2 text-body"><span className="sr-only">{label}: </span>{t(value === undefined ? "mixedValues" : value === "service" ? "fulfilmentServiceShort" : "fulfilmentPhysicalShort")}</p>;
  return (
    <SearchableSelect
      value={value ?? ""}
      ariaLabel={label}
      onValueChange={(next) => {
        if (next === "physical" || next === "service") onChange(next);
      }}
      triggerClassName="w-full"
      options={[
        ...(value === undefined ? [{ value: "", label: t("mixedValues"), disabled: true }] : []),
        { value: "physical", label: t("fulfilmentPhysicalShort") },
        { value: "service", label: t("fulfilmentServiceShort") },
      ]}
    />
  );
}

function BulkBar({ count, allSelected, printableIds, printingDisabled, canEditCosts, layout, panel, onPanel, onClear, onPrint, onRemove }: {
  count: number;
  /** The table's columns: the bar spans them, and without a Quantity column there is no quantity edit. */
  layout: RowLayout;
  allSelected: boolean;
  printableIds: string[];
  printingDisabled: boolean;
  /** The page edits costs per item: one cost for every selected variant. */
  canEditCosts: boolean;
  panel: BulkPanel;
  onPanel: (panel: BulkPanel) => void;
  onClear: () => void;
  onPrint: (ids: readonly string[]) => void;
  onRemove: () => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const { fulfilmentMode } = useProductKindRules();
  const toggle = (next: BulkPanel) => onPanel(panel === next ? null : next);
  return (
    <div className={cn("col-span-3 col-start-2 flex min-w-0 flex-wrap items-center gap-1 py-1", layout.bulkSpan)}>
      <strong className="font-medium text-foreground">{r("selected", { count })}</strong>
      <Button type="button" variant="link" size="sm" onClick={onClear}>{t("clearSelection")}</Button>
      <Button type="button" variant={panel === "price" ? "secondary" : "outline"} size="sm" aria-pressed={panel === "price"} onClick={() => toggle("price")}>
        {t("editPrices")}
      </Button>
      {layout.quantity && fulfilmentMode !== "digital" ? (
        <Button type="button" variant={panel === "stock" ? "secondary" : "outline"} size="sm" aria-pressed={panel === "stock"} onClick={() => toggle("stock")}>
          {t("editQuantities")}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {r("moreActions")}
            <ChevronDown aria-hidden="true" className="ms-1 size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {canEditCosts ? <DropdownMenuItem onSelect={() => toggle("cost")}>{t("editCosts")}</DropdownMenuItem> : null}
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

function BulkPanelRow({ panel, options, images, money, productName, selectedVariants, onApply, onCostApply, onCancel }: {
  panel: Exclude<BulkPanel, null>;
  options: DraftOption[];
  images: ProductSkuImageChoice[];
  money: Money;
  productName: string;
  selectedVariants: DraftVariant[];
  onApply: (patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>)) => void;
  /** One cost per item for every selected variant (kept by the page, not the drafts). */
  onCostApply: (cost: number) => void;
  onCancel: () => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [price, setPrice] = React.useState<number | null>(null);
  const [cost, setCost] = React.useState<number | null>(null);
  const [stock, setStock] = React.useState<number | null>(null);
  const [imageId, setImageId] = React.useState<string | null | undefined>(undefined);
  const [pattern, setPattern] = React.useState(() => defaultSkuPattern(productName, options));
  const count = selectedVariants.length;
  const kindRules = useProductKindRules();
  // Only typed quantities: a digital row's stock is its licence keys.
  const typedStock = (variant: DraftVariant) => variant.trackInventory && !isDigitalSku(kindRules, variant);
  const trackedCount = selectedVariants.filter(typedStock).length;
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
        value={price}
        onValueChange={setPrice}
        className="w-36"
      />
    );
  } else if (panel === "cost") {
    ready = cost !== null && costProblem(cost) === null;
    apply = () => onCostApply(cost!);
    field = <CostInput id={inputId} autoFocus value={cost} onValueChange={setCost} className="w-36" />;
  } else if (panel === "stock") {
    ready = stock !== null && Number.isInteger(stock) && stock >= 0 && trackedCount > 0;
    apply = () => onApply((variant) => (typedStock(variant) ? { stock: stock! } : {}));
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
    : panel === "cost" ? t("newCostFor", { count })
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

function NotForSaleList({ readOnly, combinations, valueLabel, onRestore, onRestoreAll }: {
  readOnly: boolean;
  combinations: string[][];
  valueLabel: ReadonlyMap<string, string>;
  onRestore: (valueIds: string[]) => void;
  onRestoreAll: () => void;
}) {
  const t = useMessages(productMessages);
  return (
    <div className="border-y">
      {!readOnly ? <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-2 py-2">
        <p className="text-body text-muted-foreground">{t("notForSaleHint")}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRestoreAll}>{t("turnAllOn")}</Button>
      </div> : null}
      <ul className="divide-y">
        {combinations.map((valueIds) => {
          const label = valueIds.map((id) => valueLabel.get(id) ?? "?").join(" / ");
          return (
            <li key={combinationKey(valueIds)} className="flex min-h-11 items-center justify-between gap-3 px-2 py-1.5 text-body">
              <span className="truncate text-muted-foreground">{label}</span>
              {!readOnly ? <Button type="button" variant="ghost" size="sm" onClick={() => onRestore(valueIds)} aria-label={`${t("turnOn")}: ${label}`}>
                {t("turnOn")}
              </Button> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
