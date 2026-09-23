import type { ColumnDef, TableRowData } from "../table-config";
import { Checkbox } from "~/components/ui/checkbox";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { DataTableRowActions, type ExtraAction } from "../DataTableRowActions";

/**
 * Shared column factories to eliminate boilerplate across entity column definitions.
 *
 * Usage:
 *   createSelectColumn<ProductListItem>()
 *   createDateColumn<ProductListItem>("updatedAt", "Last Updated")
 *   createActionsColumn<ProductListItem>({ ... })
 */

// ── Select (checkbox) column ─────────────────────────────────────────

interface SelectColumnOptions {
  /** Function to derive an aria-label from the row. Defaults to "row". */
  getLabel?: (row: unknown) => string;
}

// Last checkbox clicked per table, for Shift-click range selection.
const selectionAnchor = new WeakMap<object, number>();

export function createSelectColumn<T extends TableRowData>(
  opts?: SelectColumnOptions,
): ColumnDef<T, unknown> {
  const getLabel = opts?.getLabel ?? (() => "row");
  return {
    id: "select",
    header: ({ table }) => {
      const hasSelectableRows = table
        .getRowModel()
        .rows.some((row) => row.getCanSelect());
      return (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          aria-label="Select all"
          disabled={!hasSelectableRows}
        />
      );
    },
    cell: ({ row, table }) => (
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
        aria-label={`Select ${getLabel(row.original)}`}
        disabled={!row.getCanSelect()}
      />
    ),
    enableSorting: false,
    enableHiding: false,
    size: 40,
  };
}

// ── Date column ──────────────────────────────────────────────────────

interface DateColumnOptions {
  /** Whether the column header is sortable (default true). */
  sortable?: boolean;
  /** Column width (default 130). */
  size?: number;
}

export function createDateColumn<T extends TableRowData>(
  field: keyof T & string,
  title: string,
  opts?: DateColumnOptions,
): ColumnDef<T, unknown> {
  const sortable = opts?.sortable !== false;
  return {
    accessorKey: field,
    header: sortable
      ? ({ column }) => <DataTableColumnHeader column={column} title={title} />
      : () => <span className="text-caption">{title}</span>,
    cell: ({ row }) => (
      <span className="text-body text-muted-foreground" suppressHydrationWarning>
        {formatDate((row.original as Record<string, unknown>)[field] as string | Date | null)}
      </span>
    ),
    enableSorting: sortable,
    size: opts?.size ?? 130,
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

export function createActionsColumn<T extends TableRowData>(
  callbacks: ActionsColumnCallbacks<T>,
): ColumnDef<T, unknown> {
  return {
    id: "actions",
    cell: ({ row }) => {
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
    },
    enableSorting: false,
    size: callbacks.size ?? 70,
  };
}
