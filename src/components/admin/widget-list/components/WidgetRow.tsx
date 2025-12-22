// src/components/admin/widget-list/components/WidgetRow.tsx
import { TableRow, TableCell } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Trash2,
  Undo,
  XCircle,
  Pencil,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WidgetRowProps } from "../types";

const placementRuleLabels: Record<string, string> = {
  before_collection: "Before Collection",
  after_collection: "After Collection",
  fixed_top_homepage: "Fixed: Top of Homepage",
  fixed_bottom_homepage: "Fixed: Bottom of Homepage",
  standalone: "Standalone (Shortcode)",
};

export function WidgetRow({
  widget,
  collections,
  onUpdate,
  onDelete,
  onRestore,
  onPermanentDelete,
  onToggleSelection,
  onCopyShortcode,
  isSelected,
  isSaving,
  isActionLoading,
  showTrashed,
}: WidgetRowProps) {
  const getCollectionName = (collectionId: string | null) => {
    if (!collectionId) return "N/A";
    const collection = collections.find((c) => c.id === collectionId);
    return collection ? collection.name : "Unknown";
  };

  const formatPlacement = () => {
    const rule = widget.placementRule;
    if (rule === "before_collection" || rule === "after_collection") {
      return `${placementRuleLabels[rule]}: ${getCollectionName(widget.referenceCollectionId)}`;
    }
    return placementRuleLabels[rule] || "Unknown";
  };

  const handleToggleActive = () => {
    onUpdate(widget.id, { isActive: !widget.isActive });
  };

  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      className={cn(isSaving && "opacity-70")}
    >
      <TableCell className="w-10">
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelection} />
      </TableCell>
      <TableCell className="font-medium">{widget.name}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatPlacement()}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch
            checked={widget.isActive}
            onCheckedChange={handleToggleActive}
            disabled={!!widget.deletedAt || isActionLoading || isSaving}
          />
          <Badge
            variant={widget.isActive ? "default" : "secondary"}
            className={
              widget.isActive
                ? "bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
                : "bg-muted text-muted-foreground"
            }
          >
            {widget.isActive ? "Active" : "Inactive"}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="text-center">{widget.sortOrder}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {!showTrashed && (
            <>
              <Button
                variant="ghost"
                size="sm"
                asChild
                title="Edit widget"
              >
                <a href={`/admin/widgets/${widget.id}`}>
                  <Pencil className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onCopyShortcode}
                title="Copy shortcode"
              >
                <Copy className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
              </Button>
            </>
          )}
          {showTrashed ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestore}
                disabled={isSaving || isActionLoading}
                title="Restore widget"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Undo className="h-4 w-4 text-primary" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onPermanentDelete}
                disabled={isSaving || isActionLoading}
                title="Permanently delete widget"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={isSaving || isActionLoading}
              title="Move to trash"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
              )}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

