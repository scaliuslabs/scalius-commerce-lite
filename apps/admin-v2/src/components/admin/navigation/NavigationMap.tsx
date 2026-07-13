import { memo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Type,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { navigationItemMatchesQuery } from "./navigation-workspace";
import type { NavigationItem } from "./types";

interface NavigationMapProps {
  items: NavigationItem[];
  selectedId: string | null;
  expandedIds: Set<string>;
  normalizedQuery: string;
  depth?: number;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export const NavigationMap = memo(function NavigationMap({
  items,
  selectedId,
  expandedIds,
  normalizedQuery,
  depth = 0,
  onSelect,
  onToggle,
}: NavigationMapProps) {
  return (
    <ul
      role={depth === 0 ? "tree" : "group"}
      aria-label={depth === 0 ? "Menu map" : undefined}
      className={cn(depth === 0 ? "space-y-0.5 p-1.5" : "ml-4 border-l pl-1")}
    >
      {items.map((item) => {
        if (!navigationItemMatchesQuery(item, normalizedQuery)) return null;
        const children = item.subMenu ?? [];
        const hasChildren = children.length > 0;
        const isExpanded = normalizedQuery ? hasChildren : expandedIds.has(item.id);
        const isSelected = selectedId === item.id;
        const label = item.title.trim() || "Untitled item";

        return (
          <li
            key={item.id}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSelected}
            aria-expanded={hasChildren ? isExpanded : undefined}
            className="[content-visibility:auto]"
          >
            <div
              className={cn(
                "group flex min-h-9 items-center gap-1 rounded-md border border-transparent pr-1 transition-colors",
                isSelected
                  ? "border-border bg-foreground text-background shadow-sm"
                  : "hover:bg-muted/70",
              )}
            >
              {hasChildren ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8 shrink-0",
                    isSelected && "hover:bg-background/10 hover:text-background",
                  )}
                  disabled={Boolean(normalizedQuery)}
                  onClick={() => onToggle(item.id)}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
                >
                  {isExpanded ? <ChevronDown /> : <ChevronRight />}
                </Button>
              ) : (
                <span className="h-8 w-8 shrink-0" aria-hidden="true" />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                onClick={() => onSelect(item.id)}
              >
                {item.href ? (
                  <Link2 className="h-3.5 w-3.5 shrink-0 opacity-65" />
                ) : (
                  <Type className="h-3.5 w-3.5 shrink-0 opacity-65" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  <span
                    className={cn(
                      "block truncate text-[11px]",
                      isSelected ? "text-background/65" : "text-muted-foreground",
                    )}
                  >
                    {item.href || "Label only"}
                  </span>
                </span>
                {hasChildren ? (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums",
                      isSelected ? "bg-background/10" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {children.length}
                  </span>
                ) : null}
              </button>
            </div>
            {hasChildren && isExpanded ? (
              <NavigationMap
                items={children}
                selectedId={selectedId}
                expandedIds={expandedIds}
                normalizedQuery={normalizedQuery}
                depth={depth + 1}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
});
