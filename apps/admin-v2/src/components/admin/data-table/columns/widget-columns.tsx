import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "~/components/ui/badge";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import type { Widget, WidgetPlacementRule } from "~/types/api-responses";

const placementRuleLabels: Record<string, string> = {
  before_collection: "Before Collection",
  after_collection: "After Collection",
  fixed_top_homepage: "Fixed: Top of Homepage",
  fixed_bottom_homepage: "Fixed: Bottom of Homepage",
  standalone: "Standalone (Shortcode)",
};

interface CollectionOption {
  id: string;
  name: string;
}

interface WidgetColumnOptions {
  showTrashed: boolean;
  collections: CollectionOption[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onCopyShortcode: (id: string) => void;
}

function formatPlacement(
  rule: WidgetPlacementRule,
  collectionId: string | null,
  collections: CollectionOption[],
): string {
  if (rule === "before_collection" || rule === "after_collection") {
    const collectionName = collectionId
      ? collections.find((c) => c.id === collectionId)?.name ?? "Unknown"
      : "N/A";
    return `${placementRuleLabels[rule]}: ${collectionName}`;
  }
  return placementRuleLabels[rule] || "Unknown";
}

export function getWidgetColumns(
  opts: WidgetColumnOptions,
): ColumnDef<Widget, unknown>[] {
  return [
    createSelectColumn<Widget>({ getLabel: (r) => (r as Widget).name }),
    {
      accessorKey: "name",
      header: "Widget Name",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
      enableSorting: false,
      size: 200,
    },
    {
      accessorKey: "placementRule",
      header: "Placement",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatPlacement(
            row.original.placementRule,
            row.original.referenceCollectionId,
            opts.collections,
          )}
        </span>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "isActive",
      header: "Status",
      cell: ({ row }) => {
        const isTrashed = opts.showTrashed || !!row.original.deletedAt;
        return (
          <Badge
            variant={isTrashed ? "secondary" : row.original.isActive ? "default" : "secondary"}
            className={
              isTrashed
                ? "bg-muted text-muted-foreground"
                : row.original.isActive
                  ? "bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
            }
          >
            {isTrashed ? "Trashed" : row.original.isActive ? "Active" : "Inactive"}
          </Badge>
        );
      },
      enableSorting: false,
      size: 100,
    },
    {
      accessorKey: "sortOrder",
      header: "Order",
      cell: ({ row }) => (
        <span className="text-center block">{row.original.sortOrder}</span>
      ),
      enableSorting: false,
      size: 80,
    },
    createActionsColumn<Widget>({
      showTrashed: opts.showTrashed,
      onEdit: (w) => opts.onEdit(w.id),
      onDelete: (w) => opts.onDelete(w.id),
      onRestore: (w) => opts.onRestore(w.id),
      onPermanentDelete: (w) => opts.onPermanentDelete(w.id),
      getExtraActions: (w) =>
        !opts.showTrashed
          ? [{ label: "Copy Shortcode", onClick: () => opts.onCopyShortcode(w.id) }]
          : undefined,
    }),
  ];
}
