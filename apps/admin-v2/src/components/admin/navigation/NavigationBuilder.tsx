import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ExternalLink,
  FolderTree,
  GripVertical,
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
import { AddNavItemDialog } from "./AddNavItemDialog";
import { NavigationMap } from "./NavigationMap";
import {
  applyNavigationDrag,
  appendNavigationItems,
  collectNavigationParentIds,
  countNavigationItems,
  findNavigationLocation,
  flattenNavigationOutline,
  getNavigationDragIntent,
  getNavigationDepth,
  indentNavigationItemById,
  moveNavigationItemById,
  moveNavigationItemToIndexById,
  moveNavigationItemToParentById,
  outdentNavigationItemById,
  removeNavigationItemById,
  updateNavigationItemById,
  type NavigationOutlineRow,
  type NavigationDragIntent,
} from "./navigation-workspace";
import { openNavigationPreview } from "./navigation-preview";
import type { NavigationBuilderProps, NavigationItem } from "./types";
import {
  canIndentNavigationItem,
  getNavigationSubtreeDepth,
  MAX_NAV_DEPTH,
  MAX_NAV_ITEMS,
} from "./types";

export const NAVIGATION_RENDER_BATCH_SIZE = 80;
const AUTO_EXPAND_ALL_THRESHOLD = 40;

const navigationScreenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    "Press Space to pick up a menu item. Use the Up and Down arrow keys to reorder it among items with the same parent, then press Space to drop or Escape to cancel. Use the Parent, Position, Make child, and Up a level controls for precise level changes.",
};

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
  const allOutlineRows = useMemo(
    () => flattenNavigationOutline(
      navigation,
      collectNavigationParentIds(navigation),
    ),
    [navigation],
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
  const renderedRowIds = useMemo(
    () => renderedRows.map((row) => row.item.id),
    [renderedRows],
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
      return `Picked up ${location?.item.title || "menu item"}.`;
    },
    onDragOver({ active, over }) {
      const activeLocation = findNavigationLocation(navigation, String(active.id));
      const overLocation = over
        ? findNavigationLocation(navigation, String(over.id))
        : null;
      if (!overLocation) return `${activeLocation?.item.title || "Menu item"} is not over a drop target.`;
      return `${activeLocation?.item.title || "Menu item"} is over ${overLocation.item.title || "menu item"}.`;
    },
    onDragEnd({ active, over }) {
      const activeLocation = findNavigationLocation(navigation, String(active.id));
      const overLocation = over
        ? findNavigationLocation(navigation, String(over.id))
        : null;
      if (!overLocation) return `Cancelled moving ${activeLocation?.item.title || "menu item"}.`;
      return `Dropped ${activeLocation?.item.title || "menu item"} near ${overLocation.item.title || "menu item"}.`;
    },
    onDragCancel({ active }) {
      const location = findNavigationLocation(navigation, String(active.id));
      return `Cancelled moving ${location?.item.title || "menu item"}.`;
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
    setRenderLimit(NAVIGATION_RENDER_BATCH_SIZE);
  }, [expandedIds, normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) {
      setActiveDragId(null);
      setDragIntent(null);
      setDragStatus("Drag is paused while search is active.");
      return;
    }
    setDragStatus((current) => (
      current === "Drag is paused while search is active." ? "" : current
    ));
  }, [normalizedQuery]);

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

  const moveItem = useCallback(
    (id: string, direction: -1 | 1) => {
      onChange(moveNavigationItemById(navigation, id, direction));
    },
    [navigation, onChange],
  );

  const moveItemToIndex = useCallback(
    (id: string, index: number) => {
      onChange(moveNavigationItemToIndexById(navigation, id, index));
    },
    [navigation, onChange],
  );

  const moveItemToParent = useCallback(
    (id: string, parentId: string | null) => {
      onChange(moveNavigationItemToParentById(navigation, id, parentId));
      if (parentId) {
        setExpandedIds((current) => new Set(current).add(parentId));
      }
    },
    [navigation, onChange],
  );

  const indentItem = useCallback(
    (id: string) => {
      onChange(indentNavigationItemById(navigation, id));
    },
    [navigation, onChange],
  );

  const outdentItem = useCallback(
    (id: string) => {
      onChange(outdentNavigationItemById(navigation, id));
    },
    [navigation, onChange],
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
    setDragStatus(
      `Moving ${location?.item.title || "menu item"}. Drop vertically among siblings, right to nest, or left to move up a level.`,
    );
  }, [navigation, normalizedQuery]);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    if (normalizedQuery) return;
    const intent = getNavigationDragIntent(
      navigation,
      String(event.active.id),
      event.over ? String(event.over.id) : null,
      event.delta.x,
    );
    setDragIntent((current) => (
      current?.type === intent.type &&
      current.overId === intent.overId &&
      current.message === intent.message
        ? current
        : intent
    ));
    setDragStatus((current) => current === intent.message ? current : intent.message);
  }, [navigation, normalizedQuery]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const result = applyNavigationDrag(
      navigation,
      activeId,
      overId,
      event.delta.x,
    );

    if (result.changed) {
      onChange(result.items);
      if (result.intent.type === "nest") {
        const parentId = result.intent.parentId;
        setExpandedIds((current) => new Set(current).add(parentId));
      }
      setDragStatus(`${result.intent.message} Menu updated.`);
    } else {
      setDragStatus(result.intent.message);
    }

    setActiveDragId(null);
    setDragIntent(null);
  }, [navigation, onChange]);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveDragId(null);
    setDragIntent(null);
    setDragStatus("Move cancelled. The menu was not changed.");
  }, []);

  const renderInlineEditor = useCallback(
    (row: NavigationOutlineRow) => {
      const hrefResult = parseNavigationHref(row.item.href);
      const canAddChild = row.depth + 1 < MAX_NAV_DEPTH;
      const canIndent = row.index > 0 && canIndentNavigationItem(
        row.item,
        row.depth,
        MAX_NAV_DEPTH,
      );
      const descendantCount = countNavigationItems(row.item.subMenu ?? []);
      const descendantIds = new Set(
        flattenNavigationOutline(
          row.item.subMenu ?? [],
          collectNavigationParentIds(row.item.subMenu ?? []),
        ).map((item) => item.item.id),
      );
      const subtreeDepth = getNavigationSubtreeDepth(row.item);
      const parentOptions = allOutlineRows.filter((option) => (
        option.item.id !== row.item.id &&
        !descendantIds.has(option.item.id) &&
        option.depth + 1 + subtreeDepth <= MAX_NAV_DEPTH
      ));
      const label = row.item.title.trim() || "Untitled item";
      const trail = [...row.ancestors.map((item) => item.title), row.item.title]
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
              <Label htmlFor={`nav-${row.item.id}-label`}>Label</Label>
              <Input
                id={`nav-${row.item.id}-label`}
                value={row.item.title}
                onChange={(event) => updateItem(row.item.id, { title: event.target.value })}
                className="h-9"
                placeholder="Menu label"
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`nav-${row.item.id}-destination`}>Destination</Label>
                <span className="text-[11px] text-muted-foreground">
                  Empty creates a label
                </span>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <Input
                  id={`nav-${row.item.id}-destination`}
                  value={row.item.href ?? ""}
                  onChange={(event) => updateItem(row.item.id, {
                    href: event.target.value || undefined,
                  })}
                  className={cn(
                    "h-9 min-w-0 font-mono text-xs",
                    !hrefResult.ok && "border-destructive focus-visible:ring-destructive",
                  )}
                  placeholder="/products or https://example.com"
                  aria-invalid={!hrefResult.ok}
                  aria-describedby={
                    !hrefResult.ok ? `nav-${row.item.id}-destination-error` : undefined
                  }
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

          <div className="mt-3 flex min-w-0 flex-col gap-2 border-t pt-2.5 sm:flex-row sm:items-start sm:justify-between">
            <details className="group min-w-0 flex-1">
              <summary className="flex min-h-10 max-w-xl cursor-pointer list-none items-center gap-2 rounded-md border bg-muted/20 px-2.5 text-sm font-medium text-foreground hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span>Placement options</span>
                <span className="hidden truncate text-xs font-normal text-muted-foreground min-[520px]:inline">
                  Parent, position, and keyboard moves
                </span>
                <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>

              <div className="mt-2 grid min-w-0 gap-2 rounded-md border bg-muted/15 p-2.5">
                <div className="flex min-w-0 flex-wrap items-end gap-2">
                  <label className="grid min-w-40 gap-1 text-[11px] font-medium text-muted-foreground">
                    Parent
                    <select
                      value={row.parentId ?? "__root__"}
                      onChange={(event) => moveItemToParent(
                        row.item.id,
                        event.target.value === "__root__" ? null : event.target.value,
                      )}
                      className="h-9 max-w-64 rounded-md border bg-background px-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Parent for ${label}`}
                    >
                      <option value="__root__">Top level</option>
                      {parentOptions.map((option) => (
                        <option key={option.item.id} value={option.item.id}>
                          {`${"— ".repeat(option.depth)}${option.item.title.trim() || "Untitled item"}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid w-24 gap-1 text-[11px] font-medium text-muted-foreground">
                    Position
                    <Input
                      key={`${row.item.id}-${row.index}-${row.siblingCount}`}
                      type="number"
                      min={1}
                      max={row.siblingCount}
                      defaultValue={row.index + 1}
                      className="h-9 tabular-nums"
                      aria-label={`Position for ${label}`}
                      onBlur={(event) => {
                        const nextPosition = Number.parseInt(event.target.value, 10);
                        if (Number.isFinite(nextPosition)) {
                          moveItemToIndex(
                            row.item.id,
                            Math.min(row.siblingCount, Math.max(1, nextPosition)) - 1,
                          );
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </label>
                </div>

                <div
                  className="flex flex-wrap items-center gap-1"
                  role="group"
                  aria-label={`Arrange ${label}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2"
                    disabled={row.index === 0}
                    onClick={() => moveItem(row.item.id, -1)}
                  >
                    <ArrowUp /> Earlier
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2"
                    disabled={row.index === row.siblingCount - 1}
                    onClick={() => moveItem(row.item.id, 1)}
                  >
                    <ArrowDown /> Later
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2"
                    disabled={!canIndent}
                    onClick={() => indentItem(row.item.id)}
                  >
                    <ArrowRight /> Make child
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2"
                    disabled={row.depth === 0}
                    onClick={() => outdentItem(row.item.id)}
                  >
                    <ArrowLeft /> Up a level
                  </Button>
                </div>
              </div>
            </details>

            <div className="flex shrink-0 items-center justify-end gap-1">
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
          </div>
        </section>
      );
    },
    [
      allOutlineRows,
      availableItemSlots,
      getStorefrontPath,
      indentItem,
      moveItem,
      moveItemToIndex,
      moveItemToParent,
      outdentItem,
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
            <h3 className="text-sm font-semibold">Menu items</h3>
            <Badge
              variant={totalItems > MAX_NAV_ITEMS ? "destructive" : "outline"}
              className="h-5 px-1.5 font-normal tabular-nums"
            >
              {totalItems}/{MAX_NAV_ITEMS}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Open a row to edit. Drag to reorder; move right to nest or left to move up.
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

          <div
            id={normalizedQuery ? "navigation-drag-search-help" : undefined}
            className={cn(
              "flex min-h-8 items-center gap-2 border-b px-3 py-1.5 text-xs",
              normalizedQuery
                ? "bg-muted/35 text-muted-foreground"
                : activeDragId
                  ? dragIntent?.type === "invalid"
                    ? "bg-destructive/5 text-destructive"
                    : "bg-primary/5 text-foreground"
                  : "text-muted-foreground",
            )}
            role="status"
            aria-live="polite"
          >
            <GripVertical className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {normalizedQuery
                ? "Clear search to arrange items. Dragging is paused so filtered rows cannot change the wrong branch."
                : dragStatus || "Drag vertically to reorder siblings. Move right to nest or left to move up a level; Parent and Position remain available."}
            </span>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
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
                    rows={renderedRows}
                    selectedId={selectedId}
                    normalizedQuery={normalizedQuery}
                    activeDragId={activeDragId}
                    dragIntent={dragIntent}
                    dragDisabled={Boolean(normalizedQuery)}
                    onSelect={handleSelect}
                    onToggle={handleToggle}
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
                      {activeDrag.item.title.trim() || "Untitled item"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {activeDrag.item.href || "Label only"}
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
            ? findNavigationLocation(navigation, addToParentId)?.item.title
            : undefined
        }
        getStorefrontPath={getStorefrontPath}
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
