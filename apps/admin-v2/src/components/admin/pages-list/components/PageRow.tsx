// src/components/admin/pages-list/components/PageRow.tsx
import { Link } from "@tanstack/react-router";
import { TableRow, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash2, RotateCw, XCircle, ExternalLink } from "lucide-react";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import type { PageRowProps } from "../types";

const formatDate = (value: Date | string | number | null): string => {
  if (!value) return "N/A";
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return "N/A";
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "N/A";
  }
};

export function PageRow({
  page,
  onDelete,
  onRestore,
  onToggleSelection,
  onPermanentDelete,
  isSelected,
  isActionLoading,
  showTrashed,
}: PageRowProps) {
  const { getStorefrontPath } = useStorefrontUrl();

  return (
    <TableRow data-state={isSelected ? "selected" : undefined}>
      <TableCell className="w-10">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection(page.id)}
        />
      </TableCell>
      <TableCell className="font-medium">{page.title}</TableCell>
      <TableCell className="text-muted-foreground">{page.slug}</TableCell>
      <TableCell>{page.sortOrder}</TableCell>
      <TableCell>
        {page.isPublished ? (
          <Badge
            variant="default"
            className="bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-950/50 dark:text-green-400"
          >
            Published
          </Badge>
        ) : (
          <Badge variant="secondary">Draft</Badge>
        )}
      </TableCell>
      <TableCell>{formatDate(page.updatedAt)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {showTrashed ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRestore(page.id)}
                disabled={isActionLoading}
                title="Restore page"
              >
                <RotateCw className="h-4 w-4 text-primary" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPermanentDelete(page.id, page.title)}
                disabled={isActionLoading}
                title="Permanently delete page"
              >
                <XCircle className="h-4 w-4 text-destructive" />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                asChild
                title="View page on storefront"
              >
                <a
                  href={getStorefrontPath(`/${page.slug}`)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
                </a>
              </Button>
              <Button variant="ghost" size="sm" asChild title="Edit page">
                <Link to={`/admin/pages/${page.id}/edit` as string}>
                  <Pencil className="h-4 w-4 text-muted-foreground hover:text-primary transition-colors" />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(page.id, page.title)}
                disabled={isActionLoading}
                title="Move to trash"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
