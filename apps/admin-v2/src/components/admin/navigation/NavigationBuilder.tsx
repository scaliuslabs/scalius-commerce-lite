import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type CollisionDetection,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ExternalLink,
  FolderTree,
  GripVertical,
  Info,
  Maximize2,
  Menu,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { AddNavItemDialog } from "./AddNavItemDialog";
import { NavigationMap } from "./NavigationMap";
import { NavigationMoveDialog } from "./NavigationMoveDialog";
import {
  applyNavigationDrag,
  appendNavigationItems,
  collectNavigationParentIds,
  countNavigationItems,
  findNavigationLocation,
  flattenNavigationOutline,
  getNavigationDragIntent,
  getNavigationDropOperationAtPoint,
  getNavigationDepth,
  moveNavigationItemToParentAtIndexById,
  removeNavigationItemById,
  updateNavigationItemById,
  type NavigationOutlineRow,
  type NavigationDragIntent,
  type NavigationDropOperation,
} from "./navigation-workspace";
import { openNavigationPreview } from "./navigation-preview";
import type { NavigationBuilderProps, NavigationItem } from "./types";
import {
  getNavigationItemHref,
  getNavigationItemLabel,
  MAX_NAV_DEPTH,
  MAX_NAV_ITEMS,
} from "./types";

export const NAVIGATION_RENDER_BATCH_SIZE = 80;
const AUTO_EXPAND_ALL_THRESHOLD = 40;

const navigationCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

function itemLabel(item: NavigationItem | undefined, fallback = "menu item"): string {
  return item ? getNavigationItemLabel(item) : fallback;
}

const navigationScreenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    "Press Space to pick up a menu branch. Use Up and Down to choose a sibling position, then Space to drop or Escape to cancel. Use the Move action for an exact parent and position.",
};

function getActivatorClientY(event: Event): number | null {
  if ("clientY" in event && typeof event.clientY === "number") {
    return event.clientY;
  }
  if ("touches" in event) {
    const touches = event.touches;
    if (touches && typeof touches === "object" && "length" in touches) {
      const first = (touches as TouchList).item(0);
      return first?.clientY ?? null;
    }
  }
  return null;
}

function getNavigationDropOperation(
  event: DragMoveEvent | DragEndEvent,
): NavigationDropOperation {
  const overRect = event.over?.rect;
  if (!overRect) return "before";
  const startY = getActivatorClientY(event.activatorEvent);
  if (startY == null) {
    const activeRect = event.active.rect.current.translated;
    if (!activeRect) return "before";
    return activeRect.top + activeRect.height / 2 >= overRect.top + overRect.height / 2
      ? "after"
      : "before";
  }
  return getNavigationDropOperationAtPoint({
    pointerY: startY + event.delta.y,
    top: overRect.top,
    height: overRect.height,
  });
}

function getInitialExpandedIds(items: NavigationItem[]): Set<string> {
  return countNavigationItems(items) <= AUTO_EXPAND_ALL_THRESHOLD
    ? collectNavigationParentIds(items)
    : new Set();
}

type NavigationBuilderInternalProps = NavigationBuilderProps & {
  focusedSurface?: boolean;
};

export function NavigationBuilder({
  navigation,
  onChange,
  getStorefrontPath,
  focusedSurface = false,
}: NavigationBuilderInternalProps) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isFocusOpen, setIsFocusOpen] = useState(false);
  const [addToParentId, setAddToParentId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => getInitialExpandedIds(navigation),
  );
  const [renderLimit, setRenderLimit] = useState(NAVIGATION_RENDER_BATCH_SIZE);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragIntent, setDragIntent] = useState<NavigationDragIntent | null>(null);
  const [dragStatus, setDragStatus] = useState("");
  const [moveItemId, setMoveItemId] = useState<string | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const autoExpandTimerRef = useRef<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const totalItems = useMemo(() => countNavigationItems(navigation), [navigation]);
  const availableItemSlots = Math.max(0, MAX_NAV_ITEMS - totalItems);
  const maxDepth = useMemo(() => getNavigationDepth(navigation), [navigation]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const outlineRows = useMemo(
    () => flattenNavigationOutline(navigation, expandedIds, normalizedQuery),
    [expandedIds, navigation, normalizedQuery],
  );
  const matchingItems = useMemo(
    () => normalizedQuery
      ? outlineRows.filter((row) => row.matchesQuery).length
      : totalItems,
    [normalizedQuery, outlineRows, totalItems],
  );
  const renderedRows = useMemo(
    () => outlineRows.slice(0, renderLimit),
    [outlineRows, renderLimit],
  );
  const dragRows = useMemo(() => {
    if (!activeDragId) return renderedRows;
    const source = findNavigationLocation(navigation, activeDragId)?.item;
    if (!source?.subMenu?.length) return renderedRows;
    const descendantIds = new Set(
      flattenNavigationOutline(
        source.subMenu,
        collectNavigationParentIds(source.subMenu),
      ).map((row) => row.item.id),
    );
    return renderedRows.filter((row) => !descendantIds.has(row.item.id));
  }, [activeDragId, navigation, renderedRows]);
  const renderedRowIds = useMemo(
    () => dragRows.map((row) => row.item.id),
    [dragRows],
  );
  const hiddenVisibleRows = Math.max(0, outlineRows.length - renderedRows.length);
  const selected = useMemo(
    () => (selectedId ? findNavigationLocation(navigation, selectedId) : null),
    [navigation, selectedId],
  );
  const activeDrag = useMemo(
    () => (activeDragId ? findNavigationLocation(navigation, activeDragId) : null),
    [activeDragId, navigation],
  );
  const dragAnnouncements = useMemo<Announcements>(() => ({
    onDragStart({ active }) {
      const location = findNavigationLocation(navigation, String(active.id));
      return `Picked up ${itemLabel(location?.item)}.`;
    },
    onDragOver({ active, over }) {
      const activeLocation = findNavigationLocation(navigation, String(active.id));
      const overLocation = over
        ? findNavigationLocation(navigation, String(over.id))
        : null;
      if (!overLocation) return `${itemLabel(activeLocation?.item, "Menu item")} is not over a drop target.`;
      return `${itemLabel(activeLocation?.item, "Menu item")} is over ${itemLabel(overLocation.item)}.`;
    },
    onDragEnd({ active, over }) {
      const activeLocation = findNavigationLocation(navigation, String(active.id));
      const overLocation = over
        ? findNavigationLocation(navigation, String(over.id))
        : null;
      if (!overLocation) return `Cancelled moving ${itemLabel(activeLocation?.item)}.`;
      return `Dropped ${itemLabel(activeLocation?.item)} near ${itemLabel(overLocation.item)}.`;
    },
    onDragCancel({ active }) {
      const location = findNavigationLocation(navigation, String(active.id));
      return `Cancelled moving ${itemLabel(location?.item)}.`;
    },
  }), [navigation]);
  const dragAccessibility = useMemo(() => ({
    announcements: dragAnnouncements,
    screenReaderInstructions: navigationScreenReaderInstructions,
  }), [dragAnnouncements]);

  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selected, selectedId]);

  useEffect(() => {
    if (!pendingFocusId) return;
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-navigation-row-id]"),
      ).find((candidate) => candidate.dataset.navigationRowId === pendingFocusId);
      const moveButton = row?.querySelector<HTMLButtonElement>(
        "[data-navigation-move-action]",
      );
      row?.scrollIntoView?.({ block: "nearest" });
      moveButton?.focus();
      setPendingFocusId(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigation, pendingFocusId]);

  useEffect(() => {
    setRenderLimit(NAVIGATION_RENDER_BATCH_SIZE);
  }, [normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) {
      setActiveDragId(null);
      setDragIntent(null);
      setDragStatus("");
    }
  }, [normalizedQuery]);

  useEffect(() => {
    if (!dragStatus || activeDragId || normalizedQuery) return;
    const timeout = window.setTimeout(() => setDragStatus(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [activeDragId, dragStatus, normalizedQuery]);

  useEffect(() => {
    if (autoExpandTimerRef.current != null) {
      window.clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    if (
      !activeDragId ||
      dragIntent?.type !== "move" ||
      dragIntent.operation !== "inside" ||
      expandedIds.has(dragIntent.overId)
    ) {
      return;
    }
    const target = findNavigationLocation(navigation, dragIntent.overId)?.item;
    if (!target?.subMenu?.length) return;

    autoExpandTimerRef.current = window.setTimeout(() => {
      setExpandedIds((current) => new Set(current).add(dragIntent.overId));
      autoExpandTimerRef.current = null;
    }, 500);
    return () => {
      if (autoExpandTimerRef.current != null) {
        window.clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    };
  }, [activeDragId, dragIntent, expandedIds, navigation]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId((current) => current === id ? null : id);
  }, []);

  const handleToggle = useCallback(
    (id: string) => {
      setExpandedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });

      if (selected?.ancestors.some((ancestor) => ancestor.id === id)) {
        setSelectedId(null);
      }
    },
    [selected?.ancestors],
  );

  const updateItem = useCallback(
    (id: string, updates: Partial<NavigationItem>) => {
      onChange(updateNavigationItemById(navigation, id, updates));
    },
    [navigation, onChange],
  );

  const removeItem = useCallback(
    (id: string, parentId: string | null) => {
      const next = removeNavigationItemById(navigation, id);
      onChange(next);
      setSelectedId(parentId);
    },
    [navigation, onChange],
  );

  const handleExactMove = useCallback(
    (id: string, parentId: string | null, index: number) => {
      const next = moveNavigationItemToParentAtIndexById(
        navigation,
        id,
        parentId,
        index,
      );
      if (next === navigation) return;

      const nextExpanded = new Set(expandedIds);
      if (parentId) {
        const parent = findNavigationLocation(next, parentId);
        parent?.ancestors.forEach((ancestor) => nextExpanded.add(ancestor.id));
        nextExpanded.add(parentId);
      }
      const nextRows = flattenNavigationOutline(next, nextExpanded);
      const movedRowIndex = nextRows.findIndex((row) => row.item.id === id);

      setExpandedIds(nextExpanded);
      if (movedRowIndex >= 0) {
        const requiredBatch = Math.ceil(
          (movedRowIndex + 1) / NAVIGATION_RENDER_BATCH_SIZE,
        ) * NAVIGATION_RENDER_BATCH_SIZE;
        setRenderLimit((current) => Math.max(current, requiredBatch));
      }
      setSelectedId(id);
      setPendingFocusId(id);
      onChange(next);
    },
    [expandedIds, navigation, onChange],
  );

  const handleAdd = useCallback(
    (items: NavigationItem[]) => {
      onChange(appendNavigationItems(navigation, addToParentId, items));
      if (addToParentId) {
        setExpandedIds((current) => new Set(current).add(addToParentId));
      }
      setSelectedId(items[0]?.id ?? selectedId);
    },
    [addToParentId, navigation, onChange, selectedId],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (normalizedQuery) return;
    const id = String(event.active.id);
    const location = findNavigationLocation(navigation, id);
    setActiveDragId(id);
    setDragIntent(null);
    setDragStatus(`Moving ${itemLabel(location?.item)}.`);
  }, [navigation, normalizedQuery]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    if (normalizedQuery) return;
    const intent = getNavigationDragIntent(
      navigation,
      dragRows,
      String(event.active.id),
      event.over ? String(event.over.id) : null,
      getNavigationDropOperation(event),
    );
    setDragIntent((current) => (
      current?.type === intent.type &&
      current.overId === intent.overId &&
      (current.type !== "move" || intent.type !== "move" ||
        current.operation === intent.operation) &&
      current.message === intent.message
        ? current
        : intent
    ));
    setDragStatus((current) => current === intent.message ? current : intent.message);
  }, [dragRows, navigation, normalizedQuery]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const result = applyNavigationDrag(
      navigation,
      dragRows,
      activeId,
      overId,
      getNavigationDropOperation(event),
    );

    if (result.changed) {
      onChange(result.items);
      if (result.intent.type === "move" && result.intent.parentId) {
        const parentId = result.intent.parentId;
        setExpandedIds((current) => new Set(current).add(parentId));
      }
      setDragStatus(`${result.intent.message} Menu updated.`);
    } else {
      setDragStatus(result.intent.message);
    }

    setActiveDragId(null);
    setDragIntent(null);
  }, [dragRows, navigation, onChange]);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveDragId(null);
    setDragIntent(null);
    setDragStatus("Move cancelled. The menu was not changed.");
  }, []);

  const renderInlineEditor = useCallback(
    (row: NavigationOutlineRow) => {
      const resourceTarget = row.item.target.type === "resource";
      const editableDestination = row.item.target.type === "internal_path"
        ? row.item.target.path
        : row.item.target.type === "external_url"
          ? row.item.target.url
          : "";
      const hrefResult = resourceTarget
        ? parseNavigationHref(row.item.resolution?.href)
        : parseNavigationHref(editableDestination);
      const previewHref = getNavigationItemHref(row.item);
      const canAddChild = row.depth + 1 < MAX_NAV_DEPTH;
      const descendantCount = countNavigationItems(row.item.subMenu ?? []);
      const label = getNavigationItemLabel(row.item);
      const trail = [...row.ancestors.map(getNavigationItemLabel), label]
        .filter(Boolean)
        .join(" / ");

      return (
        <section
          className="border-t bg-background px-3 py-3 sm:px-4"
          aria-label="Selected menu item"
        >
          <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {trail} · Level {row.depth + 1} · Position {row.index + 1} of {row.siblingCount}
            </p>
            {descendantCount > 0 ? (
              <Badge variant="outline" className="h-5 px-1.5 font-normal">
                {descendantCount} nested
              </Badge>
            ) : null}
          </div>

          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(180px,0.8fr)_minmax(260px,1.2fr)]">
            <div className="grid min-w-0 gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`nav-${row.item.id}-label`}>Label</Label>
                {resourceTarget ? (
                  <select
                    value={row.item.labelMode}
                    onChange={(event) => updateItem(row.item.id, {
                      labelMode: event.target.value as "resource" | "custom",
                      ...(event.target.value === "custom" && !row.item.customLabel
                        ? { customLabel: label }
                        : {}),
                    })}
                    className="h-7 rounded-md border bg-background px-1.5 text-[11px] text-foreground"
                    aria-label={`Label source for ${label}`}
                  >
                    <option value="resource">Follow resource</option>
                    <option value="custom">Custom label</option>
                  </select>
                ) : null}
              </div>
              <Input
                id={`nav-${row.item.id}-label`}
                value={row.item.labelMode === "resource"
                  ? row.item.resolution?.title ?? row.item.lastKnownLabel ?? ""
                  : row.item.customLabel ?? ""}
                disabled={row.item.labelMode === "resource"}
                onChange={(event) => updateItem(row.item.id, {
                  customLabel: event.target.value,
                })}
                className="h-9"
                placeholder="Menu label"
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`nav-${row.item.id}-destination`}>Destination</Label>
                <span className="text-[11px] text-muted-foreground">
                  {resourceTarget
                    ? row.item.resolution?.readiness.replaceAll("_", " ") ?? "Checking resource"
                    : row.item.target.type === "label"
                      ? "Non-clickable group"
                      : "Custom destination"}
                </span>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <Input
                  id={`nav-${row.item.id}-destination`}
                  value={resourceTarget ? row.item.resolution?.href ?? "" : editableDestination}
                  disabled={resourceTarget || row.item.target.type === "label"}
                  onChange={(event) => {
                    if (row.item.target.type === "internal_path") {
                      updateItem(row.item.id, {
                        target: { type: "internal_path", path: event.target.value },
                      });
                    } else if (row.item.target.type === "external_url") {
                      updateItem(row.item.id, {
                        target: { type: "external_url", url: event.target.value },
                      });
                    }
                  }}
                  className={cn(
                    "h-9 min-w-0 font-mono text-xs",
                    !resourceTarget && row.item.target.type !== "label" &&
                      !hrefResult.ok && "border-destructive focus-visible:ring-destructive",
                  )}
                  placeholder={row.item.target.type === "label"
                    ? "No destination"
                    : "/products or https://example.com"}
                  aria-invalid={!resourceTarget && row.item.target.type !== "label" && !hrefResult.ok}
                  aria-describedby={
                    !resourceTarget && row.item.target.type !== "label" && !hrefResult.ok
                      ? `nav-${row.item.id}-destination-error`
                      : undefined
                  }
                />
                {previewHref ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => openNavigationPreview(previewHref, getStorefrontPath)}
                    aria-label={`Preview ${label}`}
                  >
                    <ExternalLink />
                  </Button>
                ) : null}
              </div>
              {!resourceTarget && row.item.target.type !== "label" && !hrefResult.ok ? (
                <p
                  id={`nav-${row.item.id}-destination-error`}
                  className="text-xs text-destructive"
                  role="alert"
                >
                  {hrefResult.reason}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex min-w-0 items-center justify-end gap-1 border-t pt-2.5">
            {canAddChild ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 px-2.5"
                disabled={availableItemSlots <= 0}
                onClick={() => {
                  setAddToParentId(row.item.id);
                  setIsDialogOpen(true);
                }}
              >
                <Plus /> Add child
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-10 px-2.5 text-destructive hover:text-destructive"
              onClick={() => removeItem(row.item.id, row.parentId)}
            >
              <Trash2 /> Remove{descendantCount > 0 ? ` ${descendantCount + 1} items` : ""}
            </Button>
          </div>
        </section>
      );
    },
    [
      availableItemSlots,
      getStorefrontPath,
      removeItem,
      updateItem,
    ],
  );

  return (
    <Card className="min-w-0 overflow-hidden shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Menu className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Navigation</h3>
            <Badge
              variant={totalItems > MAX_NAV_ITEMS ? "destructive" : "outline"}
              className="h-5 px-1.5 font-normal tabular-nums"
            >
              {totalItems}/{MAX_NAV_ITEMS}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="How to arrange menu items"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs leading-relaxed">
                Use the top or bottom of a row to place beside it, or the middle
                to place inside it. Use Move for an exact parent and position.
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Arrange and edit storefront links.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {!focusedSurface && navigation.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setIsFocusOpen(true)}
            >
              <Maximize2 /> Focus
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={availableItemSlots <= 0}
            onClick={() => {
              setAddToParentId(null);
              setIsDialogOpen(true);
            }}
          >
            <Plus /> Add item
          </Button>
        </div>
      </div>

      {navigation.length === 0 ? (
        <div className="grid min-h-48 place-items-center px-4 py-8 text-center">
          <div>
            <FolderTree className="mx-auto h-6 w-6 text-muted-foreground/50" />
            <p className="mt-2 text-sm font-medium">This menu is empty</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a page, category, custom link, or non-clickable label.
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              disabled={availableItemSlots <= 0}
              onClick={() => setIsDialogOpen(true)}
            >
              <Plus /> Add first item
            </Button>
          </div>
        </div>
      ) : (
        <section className="min-w-0" aria-label="Menu structure">
          <div className="flex min-w-0 flex-col gap-2 border-b p-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 pl-8 pr-14"
                placeholder="Find label or destination"
                aria-label="Find menu item"
              />
              {query ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setQuery("")}
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground sm:justify-end">
              <span className="tabular-nums">
                {normalizedQuery
                  ? `${matchingItems} ${matchingItems === 1 ? "match" : "matches"}`
                  : `${totalItems} items · ${maxDepth} levels`}
              </span>
              {!normalizedQuery ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-h-8 hover:text-foreground"
                    onClick={() => {
                      setExpandedIds(new Set());
                      setSelectedId(null);
                    }}
                  >
                    Collapse all
                  </button>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    className="min-h-8 hover:text-foreground"
                    onClick={() => setExpandedIds(collectNavigationParentIds(navigation))}
                  >
                    Expand all
                  </button>
                </span>
              ) : null}
            </div>
          </div>

          {normalizedQuery || activeDragId || dragStatus ? (
            <div
              data-navigation-drag-status
              id={normalizedQuery ? "navigation-drag-search-help" : undefined}
              className={cn(
                "flex min-h-8 items-center gap-2 border-b px-3 py-1.5 text-xs",
                normalizedQuery
                  ? "bg-muted/35 text-muted-foreground"
                  : activeDragId && dragIntent?.type === "invalid"
                    ? "bg-destructive/5 text-destructive"
                    : activeDragId
                      ? "bg-primary/5 text-foreground"
                      : "bg-muted/25 text-muted-foreground",
              )}
              role="status"
              aria-live="polite"
            >
              <GripVertical className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {normalizedQuery ? "Search active · clear to arrange." : dragStatus}
              </span>
            </div>
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={navigationCollisionDetection}
            accessibility={dragAccessibility}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <ScrollArea className="h-[min(68vh,720px)] min-h-52">
            {normalizedQuery && matchingItems === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No menu items match “{query.trim()}”.
              </div>
            ) : (
              <>
                <SortableContext
                  items={renderedRowIds}
                  strategy={verticalListSortingStrategy}
                >
                  <NavigationMap
                    rows={dragRows}
                    selectedId={selectedId}
                    normalizedQuery={normalizedQuery}
                    activeDragId={activeDragId}
                    dragIntent={dragIntent}
                    dragDisabled={Boolean(normalizedQuery)}
                    onSelect={handleSelect}
                    onToggle={handleToggle}
                    onMove={setMoveItemId}
                    renderEditor={renderInlineEditor}
                  />
                </SortableContext>
                {hiddenVisibleRows > 0 ? (
                  <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      Showing {renderedRows.length} of {outlineRows.length} visible items
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => setRenderLimit((current) => (
                        current + NAVIGATION_RENDER_BATCH_SIZE
                      ))}
                    >
                      Show next {Math.min(NAVIGATION_RENDER_BATCH_SIZE, hiddenVisibleRows)}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            </ScrollArea>

            <DragOverlay dropAnimation={null}>
              {activeDrag ? (
                <div className="flex max-w-[min(32rem,calc(100vw-2rem))] items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-lg">
                  <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {getNavigationItemLabel(activeDrag.item)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {getNavigationItemHref(activeDrag.item) || "Label only"}
                    </p>
                  </div>
                  {activeDrag.item.subMenu?.length ? (
                    <Badge variant="outline" className="shrink-0 font-normal">
                      Branch · {countNavigationItems(activeDrag.item.subMenu) + 1} items
                    </Badge>
                  ) : null}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </section>
      )}

      <AddNavItemDialog
        open={isDialogOpen}
        onClose={() => {
          setIsDialogOpen(false);
          setAddToParentId(null);
        }}
        onAdd={handleAdd}
        availableSlots={availableItemSlots}
        parentLabel={
          addToParentId
            ? itemLabel(findNavigationLocation(navigation, addToParentId)?.item)
            : undefined
        }
        getStorefrontPath={getStorefrontPath}
      />

      <NavigationMoveDialog
        open={Boolean(moveItemId)}
        itemId={moveItemId ?? ""}
        items={navigation}
        onOpenChange={(open) => {
          if (!open) setMoveItemId(null);
        }}
        onMove={handleExactMove}
      />

      {!focusedSurface ? (
        <Dialog open={isFocusOpen} onOpenChange={setIsFocusOpen}>
          <DialogContent className="grid h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[1500px] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
            <DialogHeader className="border-b px-4 py-3 pr-14 text-left">
              <DialogTitle>Focus on menu</DialogTitle>
              <DialogDescription>
                Search, edit, and arrange this menu in the full workspace.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto p-3 sm:p-4">
              <NavigationBuilder
                navigation={navigation}
                onChange={onChange}
                getStorefrontPath={getStorefrontPath}
                focusedSurface
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
