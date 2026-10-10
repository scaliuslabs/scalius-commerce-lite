import type { ReactNode } from "react";
import type { Column, ColumnDef, Row, ServerColumnMeta, TableRowData } from "../table-config";
import { Checkbox } from "~/components/ui/checkbox";
import { translate } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { localeWidth } from "../column-layout";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { DataTableRowActions, type ExtraAction } from "../DataTableRowActions";
import { LIST_DATE_WIDTH, ListDate } from "../ListDate";

/**
 * Shared column factories to eliminate boilerplate across entity column definitions.
 *
 * Usage:
 *   createSelectColumn<ProductListItem>()
 *   createDateColumn<Brand>("updatedAt", t("updated"))
 *   createActionsColumn<ProductListItem>({ ... })
 */

// ── Select (checkbox) column ─────────────────────────────────────────

interface SelectColumnOptions {
  /** Names the row in its checkbox's label ("Select PANJABI-L"); without it, "Select row". */
  getLabel?: (row: unknown) => string;
}

// Last checkbox clicked per table, for Shift-click range selection.
const selectionAnchor = new WeakMap<object, number>();

/**
 * The 16px box's hit area (C6): a 24px label (44px on phones), pulled back by
 * a negative margin so the row keeps its layout.
 */
export function CheckboxHitArea({ children }: { children: ReactNode }) {
  return <label className="-m-1 flex size-6 cursor-pointer items-center justify-center max-sm:-m-3.5 max-sm:size-11">{children}</label>;
}

export function createSelectColumn<T extends TableRowData>(
  opts?: SelectColumnOptions,
): ColumnDef<T, unknown> {
  const getLabel = opts?.getLabel;
  return {
    id: "select",
    header: ({ table }) => {
      const hasSelectableRows = table
        .getRowModel()
        .rows.some((row) => row.getCanSelect());
      return (
        <CheckboxHitArea>
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
            aria-label={translate(resourceMessages, "selectAll")}
            disabled={!hasSelectableRows}
          />
        </CheckboxHitArea>
      );
    },
    cell: ({ row, table }) => (
      <CheckboxHitArea>
      <Checkbox
        checked={row.getIsSelected()}
        onClick={(event) => {
          const anchor = selectionAnchor.get(table);
          selectionAnchor.set(table, row.index);
          if (!event.shiftKey || anchor === undefined || anchor === row.index) return;
          // Shift-click: apply this box's new state to every row in between.
          event.preventDefault();
          const select = !row.getIsSelected();
          const [from, to] = anchor < row.index ? [anchor, row.index] : [row.index, anchor];
          for (const target of table.getRowModel().rows.slice(from, to + 1)) {
            if (target.getCanSelect()) target.toggleSelected(select);
          }
        }}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        aria-label={getLabel
          ? translate(resourceMessages, "select", { name: getLabel(row.original) })
          : translate(resourceMessages, "selectRow")}
        disabled={!row.getCanSelect()}
      />
      </CheckboxHitArea>
    ),
    enableSorting: false,
    enableHiding: false,
    size: 40,
  };
}

// ── Date column ──────────────────────────────────────────────────────

function DateColumnHeader<T extends TableRowData>({ column }: { column: Column<T, unknown> }) {
  return <DataTableColumnHeader column={column} title={column.columnDef.meta?.label ?? column.id} />;
}

/** A created or updated date, as every list shows it (`ListDate`). */
export function createDateColumn<T extends TableRowData>(
  field: keyof T & string,
  title: string,
  opts: { id?: string; sortable?: boolean; priority?: number } = {},
): ColumnDef<T, unknown> {
  const sortable = opts.sortable !== false;
  return {
    id: opts.id ?? field,
    accessorFn: (row) => row[field],
    header: sortable ? DateColumnHeader : title,
    enableSorting: sortable,
    meta: { label: title, priority: opts.priority ?? 40, minWidth: localeWidth(LIST_DATE_WIDTH) },
    cell: ({ row }) => <ListDate value={row.original[field] as Date | string | number | null} />,
  };
}

// ── Actions column (wraps DataTableRowActions) ───────────────────────

interface ActionsColumnCallbacks<T> {
  showTrashed: boolean;
  onView?: (row: T) => void;
  canView?: (row: T) => boolean;
  onEdit?: (row: T) => void;
  onDelete?: (row: T) => void;
  onRestore?: (row: T) => void;
  onPermanentDelete?: (row: T) => void;
  canPermanentDelete?: (row: T) => boolean;
  /** Dynamic extra actions per row. */
  getExtraActions?: (row: T) => ExtraAction[] | undefined;
  /** Accessible name of the row's "…" button, naming the row. */
  getMenuLabel?: (row: T) => string;
  /** Column width (default 70). */
  size?: number;
}

type ActionsColumn<T extends TableRowData> = ColumnDef<T, unknown> & {
  meta: ServerColumnMeta & { actions: ActionsColumnCallbacks<T> };
};

// Keep the component type stable when a list refreshes its callbacks, so an open menu survives.
function ActionsCell<T extends TableRowData>({ row, column }: { row: Row<T>; column: Column<T, unknown> }) {
  const { actions: callbacks } = (column.columnDef as ActionsColumn<T>).meta;
  const entity = row.original;
  return (
    <DataTableRowActions
      showTrashed={callbacks.showTrashed}
      onView={
        callbacks.onView && (callbacks.canView?.(entity) ?? true)
          ? () => callbacks.onView!(entity)
          : undefined
      }
      onEdit={callbacks.onEdit ? () => callbacks.onEdit!(entity) : undefined}
      onDelete={callbacks.onDelete ? () => callbacks.onDelete!(entity) : undefined}
      onRestore={callbacks.onRestore ? () => callbacks.onRestore!(entity) : undefined}
      onPermanentDelete={
        callbacks.onPermanentDelete &&
        (callbacks.canPermanentDelete?.(entity) ?? true)
          ? () => callbacks.onPermanentDelete!(entity)
          : undefined
      }
      extraActions={callbacks.getExtraActions?.(entity)}
      menuLabel={callbacks.getMenuLabel?.(entity)}
    />
  );
}

export function createActionsColumn<T extends TableRowData>(
  callbacks: ActionsColumnCallbacks<T>,
): ActionsColumn<T> {
  return {
    id: "actions",
    cell: ActionsCell,
    meta: { actions: callbacks },
    enableSorting: false,
    size: callbacks.size ?? 70,
  };
}
