import { createContext, useContext, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, EyeClosed, EyeOff, GripVertical, Lock } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SortableList } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { isPrimaryColumn, type ColumnLayout } from "./column-layout";
import type { Column, Table, TableRowData } from "./table-config";

/** The column name people see: `meta.label`, a plain-text or `sortHeader` header, else the id. */
export function columnLabel<TData extends TableRowData>(column: Column<TData, unknown>): string {
  const header = column.columnDef.header as unknown;
  const named = typeof header === "function" ? (header as { label?: unknown }).label : undefined;
  return column.columnDef.meta?.label ?? (typeof header === "string" ? header : typeof named === "string" ? named : column.id);
}

/** Set by `DataTable`, read by the toolbar: the menu sits right of the search (Shopify). */
export const ColumnMenuContext = createContext<ReactNode>(null);

export function useColumnMenu(): ReactNode {
  return useContext(ColumnMenuContext);
}

/** The list's column layout, for the column header menus ("Hide {name}"). */
export const ColumnLayoutContext = createContext<Pick<ColumnLayout<TableRowData>, "toggle" | "isHiddenByChoice"> | null>(null);

/** The sort the list uses when none is chosen (radio value). */
const DEFAULT_SORT = "__default";

/**
 * Shopify's list menu: "Sort by" (field and direction) and "Columns" (show or
 * hide with the eye, reorder by drag or with the arrow keys on the handle),
 * plus "Reset to default". The title column is always shown.
 */
export function DataTableColumnMenu<TData extends TableRowData>({
  table,
  layout,
  defaultSortLabel,
}: {
  table: Table<TData>;
  layout: ColumnLayout<TData>;
  /**
   * What the list is sorted by when no sort is chosen, e.g. "Recently updated";
   * `false` when the list always sorts by one of its columns.
   */
  defaultSortLabel?: string | false;
}) {
  const t = useMessages(dataTableMessages);
  const sortable = table.getAllLeafColumns().filter((column) => column.getCanSort() && column.getIsVisible());
  const sorting = table.state.sorting[0];
  // A sort on a field that is not a column here (e.g. the route's "updatedAt") is the list's default order.
  const sortColumn = sorting ? sortable.find((column) => column.id === sorting.id) : undefined;
  // The title column is always first and always shown: a fixed row above the
  // sortable list, so neither drag nor arrow keys can put a column above it.
  const title = layout.arrangeable.find(isPrimaryColumn);
  const offset = title ? 1 : 0;
  const items = layout.arrangeable.filter((column) => column !== title).map((column) => ({ id: column.id, column }));

  const moveBy = (event: KeyboardEvent, id: string, index: number) => {
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const target = index + step;
    if (target < 0 || target >= items.length) return;
    layout.move(id, target + offset);
    // Keep focus on the moved row's handle.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-column-handle="${CSS.escape(id)}"]`)?.focus());
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label={t("columnMenu")} title={t("columnMenu")}>
          <ArrowUpDown />
        </Button>
      </PopoverTrigger>
      {/* As tall as the screen allows (not the popover's 24rem): every column in view. */}
      <PopoverContent align="end" className="flex max-h-(--radix-popover-content-available-height) w-80 flex-col overflow-hidden p-0">
        <div data-slot="column-menu-body" className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
          {sortable.length > 0 ? (
            <section className="space-y-2" aria-labelledby="table-sort-heading">
              <h2 id="table-sort-heading" className="text-body font-medium">{t("sortBy")}</h2>
              <RadioGroup
                aria-label={t("sortField")}
                value={sortColumn?.id ?? (defaultSortLabel === false ? "" : DEFAULT_SORT)}
                onValueChange={(id) =>
                  id === DEFAULT_SORT ? table.setSorting([]) : table.getColumn(id)?.toggleSorting(sorting?.desc ?? false)}
              >
                {/* The list's own order, so the current sort is always one of the choices. */}
                {defaultSortLabel === false ? null : (
                  <div className="flex min-h-9 items-center gap-2">
                    <RadioGroupItem value={DEFAULT_SORT} id="table-sort-default" />
                    <Label htmlFor="table-sort-default">{defaultSortLabel ?? t("defaultSort")}</Label>
                  </div>
                )}
                {sortable.map((column) => (
                  <div key={column.id} className="flex min-h-9 items-center gap-2">
                    <RadioGroupItem value={column.id} id={`table-sort-${column.id}`} />
                    <Label htmlFor={`table-sort-${column.id}`}>{columnLabel(column)}</Label>
                  </div>
                ))}
              </RadioGroup>
              <div className="grid grid-cols-2 gap-2">
                {([false, true] as const).map((desc) => (
                  <Button
                    key={String(desc)}
                    type="button"
                    size="sm"
                    variant={sortColumn && Boolean(sorting?.desc) === desc ? "secondary" : "ghost"}
                    aria-pressed={Boolean(sortColumn) && Boolean(sorting?.desc) === desc}
                    disabled={!sortColumn}
                    onClick={() => sortColumn?.toggleSorting(desc)}
                  >
                    {desc ? <ArrowDown /> : <ArrowUp />}
                    {t(desc ? "descending" : "ascending")}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}

          <section className={cn("space-y-2", sortable.length > 0 && "border-t pt-3")} aria-labelledby="table-columns-heading">
            <h2 id="table-columns-heading" className="text-body font-medium">{t("columns")}</h2>
            {title ? (
              <div data-column-fixed={title.id} className="flex min-h-9 items-center gap-1 rounded-md">
                <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground" title={t("alwaysShown")}>
                  <Lock className="size-4" aria-hidden />
                  <span className="sr-only">{t("alwaysShown")}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-body">{columnLabel(title)}</span>
              </div>
            ) : null}
            <SortableList
              items={items}
              className="space-y-0.5"
              onReorder={(next) => {
                const moved = next.find((item, index) => item.id !== items[index]?.id);
                if (moved) layout.move(moved.id, next.indexOf(moved) + offset);
              }}
              renderItem={({ id, column }, sortableProps) => {
                const name = columnLabel(column);
                const hidden = layout.isHiddenByChoice(id);
                // Shown by choice, but stepped aside because the table is narrower than its columns.
                const squeezed = !hidden && layout.autoHidden.has(id);
                const index = items.findIndex((item) => item.id === id);
                return (
                  <div
                    ref={sortableProps.ref}
                    style={sortableProps.style}
                    className="flex min-h-9 items-center gap-1 rounded-md bg-popover"
                  >
                    <button
                      type="button"
                      data-column-handle={id}
                      aria-label={t("moveColumn", { name })}
                      className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                      {...sortableProps.dragHandleProps}
                      onKeyDown={(event) => moveBy(event, id, index)}
                    >
                      <GripVertical className="size-4" aria-hidden />
                    </button>
                    <span className="min-w-0 flex-1">
                      <span data-muted={hidden || squeezed || undefined} className="block truncate text-body data-[muted]:text-muted-foreground">
                        {name}
                      </span>
                      {squeezed ? (
                        <span id={`column-squeezed-${id}`} className="block truncate text-caption text-muted-foreground">
                          {t("hiddenToFitColumn")}
                        </span>
                      ) : null}
                    </span>
                    {/* One name, its state in aria-pressed: "Show Status, pressed" means shown. */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={!hidden}
                      aria-label={t("showColumn", { name })}
                      aria-describedby={squeezed ? `column-squeezed-${id}` : undefined}
                      title={t(hidden ? "columnHidden" : squeezed ? "hiddenToFitColumn" : "columnShown")}
                      onClick={() => layout.toggle(id)}
                    >
                      {hidden ? <EyeOff aria-hidden /> : squeezed ? <EyeClosed aria-hidden /> : <Eye aria-hidden />}
                    </Button>
                  </div>
                );
              }}
            />
          </section>
        </div>

        <div data-slot="column-menu-footer" className="shrink-0 border-t p-2">
          <Button type="button" variant="ghost" size="sm" disabled={!layout.customized} onClick={layout.reset}>
            {t("resetColumns")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
