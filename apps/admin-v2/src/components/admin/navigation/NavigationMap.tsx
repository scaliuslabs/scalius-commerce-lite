import { memo, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Pencil,
  Type,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { NavigationOutlineRow } from "./navigation-workspace";

interface NavigationMapProps {
  rows: NavigationOutlineRow[];
  selectedId: string | null;
  normalizedQuery: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  renderEditor: (row: NavigationOutlineRow) => ReactNode;
}

/**
 * A compact, flat render projection of the menu hierarchy. The hierarchy is
 * encoded by depth and disclosure controls, while the active editor stays
 * directly under its row instead of occupying a permanent second pane.
 */
export const NavigationMap = memo(function NavigationMap({
  rows,
  selectedId,
  normalizedQuery,
  onSelect,
  onToggle,
  renderEditor,
}: NavigationMapProps) {
  return (
    <ol aria-label="Menu items" className="divide-y">
      {rows.map((row) => {
        const { item, depth, hasChildren, isExpanded, matchesQuery } = row;
        const isSelected = selectedId === item.id;
        const label = item.title.trim() || "Untitled item";

        return (
          <li
            key={item.id}
            className={cn(
              "[content-visibility:auto] [contain-intrinsic-size:auto_44px]",
              isSelected && "bg-muted/20",
            )}
          >
            <div
              className={cn(
                "group flex min-h-11 min-w-0 items-center gap-1 px-1.5 transition-colors hover:bg-muted/45 sm:px-2",
                isSelected && "bg-muted/45",
              )}
              style={{ paddingLeft: `${Math.min(depth, 3) * 18 + 6}px` }}
            >
              {hasChildren ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  disabled={Boolean(normalizedQuery)}
                  onClick={() => onToggle(item.id)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
                >
                  {isExpanded ? <ChevronDown /> : <ChevronRight />}
                </Button>
              ) : (
                <span className="h-9 w-9 shrink-0" aria-hidden="true" />
              )}

              <button
                type="button"
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={() => onSelect(item.id)}
                aria-expanded={isSelected}
                aria-label={`Edit ${label}, level ${depth + 1}`}
              >
                {item.href ? (
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Type className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  <span className="block truncate text-xs text-muted-foreground sm:flex-1">
                    {item.href || "Label only"}
                  </span>
                </span>
                {normalizedQuery && !matchesQuery ? (
                  <Badge variant="outline" className="hidden h-5 px-1.5 text-[10px] font-normal sm:inline-flex">
                    Parent
                  </Badge>
                ) : null}
                {hasChildren ? (
                  <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground min-[420px]:inline">
                    {item.subMenu?.length} {item.subMenu?.length === 1 ? "child" : "children"}
                  </span>
                ) : null}
              </button>

              <Button
                type="button"
                variant={isSelected ? "secondary" : "ghost"}
                size="sm"
                className="h-9 shrink-0 px-2"
                onClick={() => onSelect(item.id)}
                aria-label={`${isSelected ? "Close editor for" : "Edit"} ${label}`}
              >
                <Pencil />
                <span className="hidden sm:inline">{isSelected ? "Done" : "Edit"}</span>
              </Button>
            </div>

            {isSelected ? renderEditor(row) : null}
          </li>
        );
      })}
    </ol>
  );
});
