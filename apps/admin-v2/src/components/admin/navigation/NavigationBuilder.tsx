import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ExternalLink,
  FolderTree,
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useIsMobile } from "~/hooks/use-mobile";
import { AddNavItemDialog } from "./AddNavItemDialog";
import { NavigationMap } from "./NavigationMap";
import {
  appendNavigationItems,
  collectNavigationParentIds,
  countNavigationItems,
  findNavigationLocation,
  getNavigationDepth,
  indentNavigationItemById,
  moveNavigationItemById,
  outdentNavigationItemById,
  removeNavigationItemById,
  updateNavigationItemById,
} from "./navigation-workspace";
import { openNavigationPreview } from "./navigation-preview";
import type { NavigationBuilderProps, NavigationItem } from "./types";
import {
  canIndentNavigationItem,
  MAX_NAV_DEPTH,
  MAX_NAV_ITEMS,
} from "./types";

export function NavigationBuilder({
  navigation,
  onChange,
  getStorefrontPath,
}: NavigationBuilderProps) {
  const isMobile = useIsMobile();
  const inspectorRef = useRef<HTMLDivElement>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [addToParentId, setAddToParentId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    navigation[0]?.id ?? null,
  );
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(navigation.filter((item) => item.subMenu?.length).map((item) => item.id)),
  );

  const totalItems = useMemo(() => countNavigationItems(navigation), [navigation]);
  const availableItemSlots = MAX_NAV_ITEMS - totalItems;
  const maxDepth = useMemo(() => getNavigationDepth(navigation), [navigation]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingItems = useMemo(() => {
    if (!normalizedQuery) return totalItems;
    const countMatches = (items: NavigationItem[]): number =>
      items.reduce(
        (count, item) =>
          count +
          (`${item.title} ${item.href ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)
            ? 1
            : 0) +
          countMatches(item.subMenu ?? []),
        0,
      );
    return countMatches(navigation);
  }, [navigation, normalizedQuery, totalItems]);
  const selected = useMemo(
    () => (selectedId ? findNavigationLocation(navigation, selectedId) : null),
    [navigation, selectedId],
  );

  useEffect(() => {
    if (selected || navigation.length === 0) return;
    setSelectedId(navigation[0]?.id ?? null);
  }, [navigation, selected]);

  useEffect(() => {
    if (!selected) return;
    setExpandedIds((current) => {
      if (selected.ancestors.every((ancestor) => current.has(ancestor.id))) {
        return current;
      }
      const next = new Set(current);
      for (const ancestor of selected.ancestors) next.add(ancestor.id);
      return next;
    });
  }, [selected]);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (isMobile) {
        window.requestAnimationFrame(() =>
          inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
      }
    },
    [isMobile],
  );

  const handleToggle = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateSelected = useCallback(
    (updates: Partial<NavigationItem>) => {
      if (!selectedId) return;
      onChange(updateNavigationItemById(navigation, selectedId, updates));
    },
    [navigation, onChange, selectedId],
  );

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    const next = removeNavigationItemById(navigation, selectedId);
    onChange(next);
    setSelectedId(selected?.parentId ?? next[0]?.id ?? null);
  }, [navigation, onChange, selected?.parentId, selectedId]);

  const moveSelected = useCallback(
    (direction: -1 | 1) => {
      if (!selectedId) return;
      onChange(moveNavigationItemById(navigation, selectedId, direction));
    },
    [navigation, onChange, selectedId],
  );

  const indentSelected = useCallback(() => {
    if (!selectedId) return;
    onChange(indentNavigationItemById(navigation, selectedId));
  }, [navigation, onChange, selectedId]);

  const outdentSelected = useCallback(() => {
    if (!selectedId) return;
    onChange(outdentNavigationItemById(navigation, selectedId));
  }, [navigation, onChange, selectedId]);

  const handleAdd = useCallback(
    (items: NavigationItem[]) => {
      const next = appendNavigationItems(navigation, addToParentId, items);
      onChange(next);
      if (addToParentId) {
        setExpandedIds((current) => new Set(current).add(addToParentId));
      }
      setSelectedId(items[0]?.id ?? selectedId);
    },
    [addToParentId, navigation, onChange, selectedId],
  );

  const hrefResult = parseNavigationHref(selected?.item.href);
  const canAddChild = Boolean(selected && selected.depth + 1 < MAX_NAV_DEPTH);
  const canIndent = Boolean(
    selected &&
      selected.index > 0 &&
      canIndentNavigationItem(selected.item, selected.depth, MAX_NAV_DEPTH),
  );

  return (
    <Card className="overflow-hidden shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Menu className="h-4 w-4" />
            <h3 className="text-sm font-semibold">Menu workspace</h3>
            <Badge variant="outline" className="h-5 px-1.5 font-normal tabular-nums">
              {totalItems}/{MAX_NAV_ITEMS}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Find an item, select it in the map, then edit or arrange it.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={availableItemSlots <= 0}
          onClick={() => {
            setAddToParentId(null);
            setIsDialogOpen(true);
          }}
        >
          <Plus />
          Add item
        </Button>
      </div>

      {navigation.length === 0 ? (
        <div className="grid min-h-56 place-items-center px-4 py-10 text-center">
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
              <Plus />
              Add first item
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 lg:grid-cols-[minmax(270px,0.82fr)_minmax(360px,1.18fr)]">
          <section className="min-w-0 border-b lg:border-b-0 lg:border-r" aria-label="Menu map">
            <div className="space-y-2 border-b p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 pl-8 pr-16"
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
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="tabular-nums">
                  {normalizedQuery ? `${matchingItems} matches` : `${totalItems} items · ${maxDepth} levels`}
                </span>
                {!normalizedQuery ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => setExpandedIds(new Set())}
                    >
                      Collapse all
                    </button>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => setExpandedIds(collectNavigationParentIds(navigation))}
                    >
                      Expand all
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
            <ScrollArea className="h-[min(46vh,520px)] lg:h-[min(64vh,680px)]">
              {normalizedQuery && matchingItems === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No menu items match “{query.trim()}”.
                </div>
              ) : (
                <NavigationMap
                  items={navigation}
                  selectedId={selectedId}
                  expandedIds={expandedIds}
                  normalizedQuery={normalizedQuery}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
              )}
            </ScrollArea>
          </section>

          <section
            ref={inspectorRef}
            className="min-w-0 scroll-mt-20 bg-muted/10"
            aria-label="Selected menu item"
          >
            {selected ? (
              <div className="mx-auto max-w-2xl p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {selected.item.title.trim() || "Untitled item"}
                      </span>
                      <Badge variant="secondary" className="h-5 px-1.5 font-normal">
                        Level {selected.depth + 1}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {[...selected.ancestors.map((item) => item.title), selected.item.title]
                        .filter(Boolean)
                        .join(" / ")}
                    </p>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Position {selected.index + 1} of {selected.siblingCount}
                  </span>
                </div>

                <div className="grid gap-3 py-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`nav-${selected.item.id}-label`}>Label</Label>
                    <Input
                      id={`nav-${selected.item.id}-label`}
                      value={selected.item.title}
                      onChange={(event) => updateSelected({ title: event.target.value })}
                      className="h-9"
                      placeholder="Menu label"
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`nav-${selected.item.id}-destination`}>Destination</Label>
                      <span className="text-[11px] text-muted-foreground">
                        Leave empty for a label only
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <Input
                        id={`nav-${selected.item.id}-destination`}
                        value={selected.item.href ?? ""}
                        onChange={(event) =>
                          updateSelected({ href: event.target.value || undefined })
                        }
                        className={cn(
                          "h-9 min-w-0 font-mono text-xs",
                          !hrefResult.ok && "border-destructive focus-visible:ring-destructive",
                        )}
                        placeholder="/products or https://example.com"
                        aria-invalid={!hrefResult.ok}
                        aria-describedby={
                          !hrefResult.ok ? `nav-${selected.item.id}-destination-error` : undefined
                        }
                      />
                      {hrefResult.ok && hrefResult.href ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9 shrink-0"
                          onClick={() =>
                            openNavigationPreview(hrefResult.href, getStorefrontPath)
                          }
                          aria-label={`Preview ${selected.item.title || "menu item"}`}
                        >
                          <ExternalLink />
                        </Button>
                      ) : null}
                    </div>
                    {!hrefResult.ok ? (
                      <p
                        id={`nav-${selected.item.id}-destination-error`}
                        className="text-xs text-destructive"
                        role="alert"
                      >
                        {hrefResult.reason}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-md border bg-background">
                  <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                    <div>
                      <p className="text-xs font-medium">Position and nesting</p>
                      <p className="text-[11px] text-muted-foreground">
                        Native controls work with mouse, touch, and keyboard.
                      </p>
                    </div>
                    <Badge variant="outline" className="font-normal">
                      {selected.item.subMenu?.length ?? 0} children
                    </Badge>
                  </div>
                  <div
                    className="grid grid-cols-2 gap-1.5 p-2 sm:grid-cols-4"
                    role="group"
                    aria-label={`Arrange ${selected.item.title || "menu item"}`}
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      disabled={selected.index === 0}
                      onClick={() => moveSelected(-1)}
                    >
                      <ArrowUp /> Earlier
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      disabled={selected.index === selected.siblingCount - 1}
                      onClick={() => moveSelected(1)}
                    >
                      <ArrowDown /> Later
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      disabled={!canIndent}
                      onClick={indentSelected}
                    >
                      <ArrowRight /> Make child
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      disabled={selected.depth === 0}
                      onClick={outdentSelected}
                    >
                      <ArrowLeft /> Up a level
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={removeSelected}
                  >
                    <Trash2 /> Remove item
                  </Button>
                  {canAddChild ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={availableItemSlots <= 0}
                      onClick={() => {
                        setAddToParentId(selected.item.id);
                        setIsDialogOpen(true);
                      }}
                    >
                      <Plus /> Add child
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Maximum depth reached
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid min-h-64 place-items-center p-6 text-sm text-muted-foreground">
                Select an item in the menu map to edit it.
              </div>
            )}
          </section>
        </div>
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
    </Card>
  );
}
