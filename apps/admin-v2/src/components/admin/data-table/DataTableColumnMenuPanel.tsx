// The columns menu's controls: show, hide, reorder by drag or with the arrow
// keys on the handle, and "Reset to default". Loaded when the menu first
// opens, or on hover or focus of its button.
import { Suspense, lazy, type KeyboardEvent, type ReactNode } from "react";
import { Eye, EyeClosed, EyeOff, GripVertical, Lock } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { SortableListProps } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { isPrimaryColumn, type ColumnLayout } from "./column-layout";
import { columnLabel } from "./DataTableColumnMenu";
import type { Table, TableRowData } from "./table-config";

const SortableList = lazy(() => import("~/components/admin/shared/SortableList").then((module) => ({ default: module.SortableList }))) as <T extends { id: string }>(
  props: SortableListProps<T>,
) => ReactNode;

export interface ColumnMenuPanelProps<TData extends TableRowData> {
  table: Table<TData>;
  layout: ColumnLayout<TData>;
}

export function ColumnMenuPanel<TData extends TableRowData>({ layout }: ColumnMenuPanelProps<TData>) {
  const t = useMessages(dataTableMessages);
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
    <>
      <div data-slot="column-menu-body" className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
        <section className="space-y-2" aria-labelledby="table-columns-heading">
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
          <Suspense fallback={null}>
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
          </Suspense>
        </section>
      </div>

      <div data-slot="column-menu-footer" className="shrink-0 border-t p-2">
        <Button type="button" variant="ghost" size="sm" disabled={!layout.customized} onClick={layout.reset}>
          {t("resetColumns")}
        </Button>
      </div>
    </>
  );
}
