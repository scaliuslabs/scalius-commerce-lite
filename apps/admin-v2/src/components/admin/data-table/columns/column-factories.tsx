import type { ColumnDef } from "@tanstack/react-table";
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

export function createSelectColumn<T>(
  opts?: SelectColumnOptions,
): ColumnDef<T, unknown> {
  const getLabel = opts?.getLabel ?? (() => "row");
  return {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(!!v)}
        aria-label={`Select ${getLabel(row.original)}`}
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

export function createDateColumn<T>(
  field: keyof T & string,
  title: string,
  opts?: DateColumnOptions,
): ColumnDef<T, unknown> {
  const sortable = opts?.sortable !== false;
  return {
    accessorKey: field,
    header: sortable
      ? ({ column }) => <DataTableColumnHeader column={column} title={title} />
      : () => <span className="text-xs">{title}</span>,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground" suppressHydrationWarning>
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
  onEdit?: (row: T) => void;
  onDelete: (row: T) => void;
  onRestore: (row: T) => void;
  onPermanentDelete: (row: T) => void;
  /** Dynamic extra actions per row. */
  getExtraActions?: (row: T) => ExtraAction[] | undefined;
  /** Column width (default 70). */
  size?: number;
}

export function createActionsColumn<T>(
  callbacks: ActionsColumnCallbacks<T>,
): ColumnDef<T, unknown> {
  return {
    id: "actions",
    cell: ({ row }) => {
      const entity = row.original;
      return (
        <DataTableRowActions
          showTrashed={callbacks.showTrashed}
          onView={callbacks.onView ? () => callbacks.onView!(entity) : undefined}
          onEdit={callbacks.onEdit ? () => callbacks.onEdit!(entity) : undefined}
          onDelete={() => callbacks.onDelete(entity)}
          onRestore={() => callbacks.onRestore(entity)}
          onPermanentDelete={() => callbacks.onPermanentDelete(entity)}
          extraActions={callbacks.getExtraActions?.(entity)}
        />
      );
    },
    enableSorting: false,
    size: callbacks.size ?? 70,
  };
}
