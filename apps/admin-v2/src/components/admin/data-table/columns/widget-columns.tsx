import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "~/components/ui/badge";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import type { Widget, WidgetPlacement } from "~/types/api-responses";

interface WidgetColumnOptions {
  showTrashed: boolean;
  getCollectionName: (id: string) => string | null;
  getPageTitle: (id: string) => string | null;
  getProductName: (id: string) => string | null;
  getCategoryName: (id: string) => string | null;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onCopyShortcode: (id: string) => void;
}

const scopeLabels: Record<string, string> = {
  homepage: "Homepage",
  page: "Page",
  product: "Product",
  category: "Category",
  collection: "Collection",
};

const slotLabels: Record<string, string> = {
  top: "top",
  bottom: "bottom",
  before_content: "before content",
  after_content: "after content",
  before_collection: "before collection",
  after_collection: "after collection",
};

function placementTargetLabel(
  placement: WidgetPlacement,
  opts: Pick<WidgetColumnOptions, "getCollectionName" | "getPageTitle" | "getProductName" | "getCategoryName">,
): string | null {
  if (placement.scope === "page" && placement.scopeId) {
    return opts.getPageTitle(placement.scopeId) ?? placement.scopeId;
  }
  if (placement.scope === "product" && placement.scopeId) {
    return opts.getProductName(placement.scopeId) ?? placement.scopeId;
  }
  if (placement.scope === "category" && placement.scopeId) {
    return opts.getCategoryName(placement.scopeId) ?? placement.scopeId;
  }
  if (placement.scope === "collection" && placement.scopeId) {
    return opts.getCollectionName(placement.scopeId) ?? placement.scopeId;
  }
  if (placement.anchorType === "collection" && placement.anchorId) {
    return opts.getCollectionName(placement.anchorId) ?? placement.anchorId;
  }
  return null;
}

function formatPlacementSummary(
  widget: Widget,
  opts: Pick<WidgetColumnOptions, "getCollectionName" | "getPageTitle" | "getProductName" | "getCategoryName">,
): string {
  const activePlacements = (widget.placements ?? [])
    .filter((placement) => placement.deletedAt == null && placement.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (activePlacements.length === 0) {
    return "Shortcode only";
  }

  const [firstPlacement] = activePlacements;
  const scope = scopeLabels[firstPlacement.scope] ?? firstPlacement.scope;
  const slot = slotLabels[firstPlacement.slot] ?? firstPlacement.slot;
  const target = placementTargetLabel(firstPlacement, opts);
  const extraCount = activePlacements.length - 1;
  const suffix = extraCount > 0 ? ` + ${extraCount} more` : "";

  return `${scope} ${slot}${target ? `: ${target}` : ""}${suffix}`;
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
          {formatPlacementSummary(row.original, opts)}
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
