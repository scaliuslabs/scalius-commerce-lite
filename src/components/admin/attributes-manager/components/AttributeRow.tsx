// src/components/admin/attributes-manager/components/AttributeRow.tsx
import { useState, useEffect } from "react";
import { TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Trash2, Undo, XCircle, Filter, Edit3 } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import type { AttributeRowProps } from "../types";

export function AttributeRow({
  attribute,
  onUpdate,
  onDelete,
  onRestore,
  onToggleSelection,
  onPermanentDelete,
  onViewValues,
  onEditValues,
  isSelected,
  isSaving,
  isActionLoading,
  showTrashed,
}: AttributeRowProps) {
  const [name, setName] = useState(attribute.name);
  const [slug, setSlug] = useState(attribute.slug);
  const [isFilterable, setIsFilterable] = useState(attribute.filterable);

  const debouncedName = useDebounce(name, 700);
  const debouncedSlug = useDebounce(slug, 700);

  useEffect(() => {
    setName(attribute.name);
    setSlug(attribute.slug);
    setIsFilterable(attribute.filterable);
  }, [attribute]);

  useEffect(() => {
    if (debouncedName !== attribute.name && debouncedName.length >= 2) {
      onUpdate(attribute.id, { name: debouncedName });
    }
  }, [debouncedName, attribute.name, attribute.id, onUpdate]);

  useEffect(() => {
    if (debouncedSlug !== attribute.slug && debouncedSlug.length >= 2) {
      onUpdate(attribute.id, { slug: debouncedSlug });
    }
  }, [debouncedSlug, attribute.slug, attribute.id, onUpdate]);

  const handleFilterableChange = (checked: boolean) => {
    setIsFilterable(checked);
    onUpdate(attribute.id, { filterable: checked });
  };

  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      className={cn(isSaving && "opacity-70")}
    >
      <TableCell className="w-10">
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelection} />
      </TableCell>
      <TableCell>
        <div className="relative">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={cn("h-9 text-sm", isSaving && "pr-8")}
            disabled={!!attribute.deletedAt || isActionLoading}
          />
          {isSaving && (
            <Loader2 className="h-3 w-3 animate-spin absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="relative">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className={cn("h-9 text-sm font-mono", isSaving && "pr-8")}
            disabled={!!attribute.deletedAt || isActionLoading}
          />
          {isSaving && (
            <Loader2 className="h-3 w-3 animate-spin absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Switch
            checked={isFilterable}
            onCheckedChange={handleFilterableChange}
            disabled={!!attribute.deletedAt || isActionLoading}
          />
          {isFilterable && (
            <Badge variant="secondary" className="text-xs">
              <Filter className="h-3 w-3 mr-1" />
              Filterable
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onViewValues}
          disabled={!attribute.valueCount || attribute.valueCount === 0}
          className="h-auto p-1"
          title="View attribute values and usage"
        >
          <Badge
            variant="outline"
            className="font-mono text-xs hover:bg-accent cursor-pointer"
          >
            {attribute.valueCount ?? 0}
          </Badge>
        </Button>
      </TableCell>
      <TableCell className="text-right">
        {showTrashed ? (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRestore}
              disabled={isSaving || isActionLoading}
              title="Restore attribute"
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
              title="Permanently delete attribute"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onEditValues}
              disabled={isSaving || isActionLoading}
              title="Edit attribute values"
            >
              <Edit3 className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
            </Button>
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
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
