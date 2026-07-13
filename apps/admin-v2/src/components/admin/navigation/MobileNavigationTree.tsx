import { memo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  Trash2,
} from "lucide-react";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { NavigationItem } from "./types";
import {
  canIndentNavigationItem,
  getDepthColor,
  MAX_NAV_DEPTH,
} from "./types";
import { openNavigationPreview } from "./navigation-preview";

interface MobileNavigationTreeProps {
  navigation: NavigationItem[];
  arranging: boolean;
  maxDepth?: number;
  onUpdate: (path: string, index: number, item: Partial<NavigationItem>) => void;
  onRemove: (path: string, index: number) => void;
  onAddChild: (parentPath: string) => void;
  onIndent: (path: string, index: number) => void;
  onOutdent: (path: string, index: number) => void;
  onMove: (path: string, oldIndex: number, newIndex: number) => void;
  getStorefrontPath: (path: string) => string;
}

interface MobileNavigationItemProps extends Omit<MobileNavigationTreeProps, "navigation"> {
  item: NavigationItem;
  index: number;
  siblingCount: number;
  depth: number;
  parentPath: string;
}

const MobileNavigationItem = memo(function MobileNavigationItem({
  item,
  index,
  siblingCount,
  depth,
  parentPath,
  arranging,
  maxDepth = MAX_NAV_DEPTH,
  onUpdate,
  onRemove,
  onAddChild,
  onIndent,
  onOutdent,
  onMove,
  getStorefrontPath,
}: MobileNavigationItemProps) {
  const [expanded, setExpanded] = useState(true);
  const currentPath = parentPath ? `${parentPath}.${index}` : `${index}`;
  const children = item.subMenu ?? [];
  const hasChildren = children.length > 0;
  const hrefResult = parseNavigationHref(item.href);
  const label = item.title.trim() || `Untitled item ${index + 1}`;
  const fieldId = `mobile-nav-${item.id}`;
  const childrenId = `${fieldId}-children`;
  const canAddChildren = depth + 1 < maxDepth;
  const canIndent = index > 0 && canIndentNavigationItem(item, depth, maxDepth);
  const canOutdent = depth > 0;

  return (
    <li>
      <article
        className={cn(
          "overflow-hidden rounded-md border border-l-[3px] bg-card",
          getDepthColor(depth),
        )}
        aria-label={`${label}, level ${depth + 1}`}
      >
        <header className="flex min-h-10 items-center gap-1.5 border-b bg-muted/15 px-2 py-1.5">
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              aria-controls={childrenId}
              aria-label={`${expanded ? "Collapse" : "Expand"} children of ${label}`}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </Button>
          ) : (
            <span className="h-8 w-8 shrink-0" aria-hidden="true" />
          )}
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
            Level {depth + 1}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
          {hasChildren ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {children.length} {children.length === 1 ? "child" : "children"}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 px-2 text-destructive hover:text-destructive"
            onClick={() => onRemove(parentPath, index)}
            aria-label={`Remove ${label}`}
          >
            <Trash2 />
            <span className="sr-only min-[360px]:not-sr-only">Remove</span>
          </Button>
        </header>

        <div className="space-y-2 p-2.5">
          <div className="grid gap-1">
            <Label htmlFor={`${fieldId}-label`} className="text-[11px] text-muted-foreground">
              Label
            </Label>
            <Input
              id={`${fieldId}-label`}
              value={item.title}
              onChange={(event) => onUpdate(parentPath, index, { title: event.target.value })}
              className="h-9 text-sm"
              placeholder="Menu label"
            />
          </div>

          <div className="grid gap-1">
            <Label htmlFor={`${fieldId}-destination`} className="text-[11px] text-muted-foreground">
              Destination <span className="font-normal">(empty creates a label)</span>
            </Label>
            <div className="flex gap-1.5">
              <Input
                id={`${fieldId}-destination`}
                value={item.href ?? ""}
                onChange={(event) => onUpdate(parentPath, index, {
                  href: event.target.value || undefined,
                })}
                className={cn(
                  "h-9 min-w-0 font-mono text-xs",
                  !hrefResult.ok && "border-destructive focus-visible:ring-destructive",
                )}
                placeholder="/collection or https://…"
                aria-invalid={!hrefResult.ok}
                aria-describedby={!hrefResult.ok ? `${fieldId}-destination-error` : undefined}
              />
              {hrefResult.ok && hrefResult.href ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => openNavigationPreview(hrefResult.href, getStorefrontPath)}
                  aria-label={`Preview ${label}`}
                >
                  <ExternalLink />
                </Button>
              ) : null}
            </div>
            {!hrefResult.ok ? (
              <p id={`${fieldId}-destination-error`} className="text-xs leading-4 text-destructive" role="alert">
                {hrefResult.reason}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            {canAddChildren ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2"
                onClick={() => onAddChild(currentPath)}
                aria-label={`Add child under ${label}`}
              >
                <Plus />
                Add child
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">Maximum depth reached</span>
            )}
            {!arranging ? (
              <span className="text-[11px] text-muted-foreground">
                Position {index + 1} of {siblingCount}
              </span>
            ) : null}
          </div>

          {arranging ? (
            <div className="grid grid-cols-2 gap-1.5 border-t pt-2" role="group" aria-label={`Arrange ${label}`}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 justify-start px-2"
                disabled={index === 0}
                onClick={() => onMove(parentPath, index, index - 1)}
                aria-label={`Move ${label} earlier`}
              >
                <ArrowUp />Earlier
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 justify-start px-2"
                disabled={index === siblingCount - 1}
                onClick={() => onMove(parentPath, index, index + 1)}
                aria-label={`Move ${label} later`}
              >
                <ArrowDown />Later
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 justify-start px-2"
                disabled={!canIndent}
                onClick={() => onIndent(parentPath, index)}
                aria-label={`Make ${label} a child of the previous item`}
              >
                <ArrowRight />Make child
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 justify-start px-2"
                disabled={!canOutdent}
                onClick={() => onOutdent(parentPath, index)}
                aria-label={`Move ${label} up one level`}
              >
                <ArrowLeft />Up a level
              </Button>
            </div>
          ) : null}
        </div>
      </article>

      {hasChildren && expanded ? (
        <ol id={childrenId} className="ml-2 mt-2 space-y-2 border-l pl-2" aria-label={`Children of ${label}`}>
          {children.map((child, childIndex) => (
            <MobileNavigationItem
              key={child.id}
              item={child}
              index={childIndex}
              siblingCount={children.length}
              depth={depth + 1}
              parentPath={currentPath}
              arranging={arranging}
              maxDepth={maxDepth}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onAddChild={onAddChild}
              onIndent={onIndent}
              onOutdent={onOutdent}
              onMove={onMove}
              getStorefrontPath={getStorefrontPath}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
});

export function MobileNavigationTree({
  navigation,
  arranging,
  maxDepth = MAX_NAV_DEPTH,
  onUpdate,
  onRemove,
  onAddChild,
  onIndent,
  onOutdent,
  onMove,
  getStorefrontPath,
}: MobileNavigationTreeProps) {
  return (
    <ol className="space-y-2 p-2" aria-label="Menu items">
      {navigation.map((item, index) => (
        <MobileNavigationItem
          key={item.id}
          item={item}
          index={index}
          siblingCount={navigation.length}
          depth={0}
          parentPath=""
          arranging={arranging}
          maxDepth={maxDepth}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onAddChild={onAddChild}
          onIndent={onIndent}
          onOutdent={onOutdent}
          onMove={onMove}
          getStorefrontPath={getStorefrontPath}
        />
      ))}
    </ol>
  );
}
