/**
 * The page's layers as WAI-ARIA trees (research P10, P17, P18): one per
 * group (shared on all pages, the page, the footer). Arrow keys move
 * between rows, Right and Left open and close a section's blocks, Enter
 * opens a row's settings, Space picks a row up (arrows move it, Space drops,
 * Esc puts it back), Alt+arrows move it at once, Shift+F10 opens its menu
 * and Delete removes it. Every drag (the grip, with a pointer) has those
 * keyboard and menu alternatives (WCAG 2.5.7). Hovering a row outlines it
 * in the preview.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronRight, Eye, EyeOff, GripVertical, MoreHorizontal, Plus, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";

export interface TreeItemModel {
  id: string;
  name: string;
  icon?: LucideIcon;
  /** A second line: why buyers don't see it, what is wrong, what it is. */
  note?: string;
  noteTone?: "muted" | "critical";
  badge?: "ai" | "app";
  hidden?: boolean;
  children?: TreeItemModel[];
  /** Its place among the siblings it moves with (`list` names them). */
  move?: { list: string; index: number; count: number };
  onToggleHidden?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** Opens the section library to add after this row. */
  onAddAfter?: () => void;
  /** A row that adds (a block, a section) instead of naming one. */
  add?: () => void;
}

export interface TreeGroupModel {
  id: string;
  label: string;
  /** Shared on every page: drawn in the shared colour. */
  shared?: boolean;
  note?: string;
  items: TreeItemModel[];
}

interface Visible {
  item: TreeItemModel;
  level: number;
  parent: string | null;
  setSize: number;
  position: number;
}

function flatten(items: readonly TreeItemModel[], expanded: ReadonlySet<string>, level = 1, parent: string | null = null): Visible[] {
  return items.flatMap((item, index) => [
    { item, level, parent, setSize: items.length, position: index + 1 },
    ...(item.children && expanded.has(item.id) ? flatten(item.children, expanded, level + 1, item.id) : []),
  ]);
}

function Row({ entry, selected, focused, expanded, picked, onFocusRow, onSelect, onHover, onToggleExpanded, rowRef, menuOpen, onMenuOpenChange, onMove }: {
  entry: Visible;
  selected: boolean;
  focused: boolean;
  expanded: boolean;
  picked: boolean;
  onFocusRow: () => void;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
  onToggleExpanded: () => void;
  rowRef: (element: HTMLLIElement | null) => void;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onMove: (to: number) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const { item, level } = entry;
  const sortable = useSortable({ id: item.id, disabled: !item.move });
  const Icon = item.add ? Plus : item.icon;
  const hasChildren = Boolean(item.children?.length);
  const menu = !item.add && (item.move || item.onDuplicate || item.onRemove || item.onToggleHidden || item.onAddAfter);
  return (
    <li
      ref={(element) => {
        sortable.setNodeRef(element);
        rowRef(element);
      }}
      role="treeitem"
      aria-level={level}
      aria-setsize={entry.setSize}
      aria-posinset={entry.position}
      aria-selected={item.add ? undefined : selected}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-grabbed={item.move ? picked : undefined}
      tabIndex={focused ? 0 : -1}
      data-tree-row={item.id}
      // A dragged row and the rows making room move by runtime offsets (custom properties).
      style={{ "--sort-y": `${sortable.transform?.y ?? 0}px`, "--indent": `${(level - 1) * 20}px` } as CSSProperties}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusRow();
      }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, [role=menuitem]")) return;
        onFocusRow();
        if (item.add) item.add();
        else onSelect();
      }}
      className={cn(
        "group relative flex min-h-10 translate-y-(--sort-y) cursor-pointer items-center gap-0.5 rounded-lg ps-(--indent) pe-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
        picked && "bg-accent ring-2 ring-ring",
        sortable.isDragging ? "z-20 bg-card opacity-80 shadow-popover" : "transition-[translate] duration-200 motion-reduce:transition-none",
      )}
    >
      {item.move ? (
        <span
          ref={sortable.setActivatorNodeRef}
          {...sortable.listeners}
          aria-hidden="true"
          className="grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 pointer-coarse:hidden"
        >
          <GripVertical className="size-4" />
        </span>
      ) : (
        <span className="size-7 shrink-0 pointer-coarse:hidden" aria-hidden="true" />
      )}
      {hasChildren ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          aria-label={t(expanded ? "collapseItem" : "expandItem", { name: item.name })}
          onClick={onToggleExpanded}
        >
          <ChevronRight className={cn(expanded && "rotate-90")} aria-hidden="true" />
        </Button>
      ) : (
        <span className="size-7 shrink-0" aria-hidden="true" />
      )}
      {Icon ? <span className="flex h-lh items-center text-muted-foreground"><Icon className="size-4" aria-hidden="true" /></span> : null}
      <span className="min-w-0 flex-1 py-1.5 ps-1.5">
        <span className={cn("flex items-center gap-1.5 text-body", (item.hidden || item.add) && "text-muted-foreground")}>
          <span className="truncate">{item.name}</span>
          {item.badge === "ai" ? (
            <Badge variant="info" className="shrink-0"><Sparkles aria-hidden="true" />{t("aiDraftBadge")}</Badge>
          ) : item.badge === "app" ? (
            <Badge variant="secondary" className="shrink-0">{t("appBadge")}</Badge>
          ) : null}
        </span>
        {item.note ? (
          <span className={cn("block text-body", item.noteTone === "critical" ? "text-destructive" : "text-muted-foreground")}>{item.note}</span>
        ) : null}
      </span>
      {item.onToggleHidden ? (
        // A shown row's eye appears on hover or focus (always on touch screens); a hidden row's stays, so the state reads at a glance.
        <span className={cn("flex", !item.hidden && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            aria-label={t(item.hidden ? "showItem" : "hideItem", { name: item.name })}
            aria-pressed={!item.hidden}
            onClick={item.onToggleHidden}
          >
            {item.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </span>
      ) : null}
      {menu ? (
        <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" tabIndex={-1} aria-label={t("sectionActions", { name: item.name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.move ? (
              <>
                <DropdownMenuItem disabled={item.move.index === 0} onSelect={() => onMove(item.move!.index - 1)}>{t("moveUp")}</DropdownMenuItem>
                <DropdownMenuItem disabled={item.move.index === item.move.count - 1} onSelect={() => onMove(item.move!.index + 1)}>{t("moveDown")}</DropdownMenuItem>
              </>
            ) : null}
            {item.onToggleHidden ? <DropdownMenuItem onSelect={item.onToggleHidden}>{t(item.hidden ? "show" : "hide")}</DropdownMenuItem> : null}
            {item.onDuplicate ? <DropdownMenuItem onSelect={item.onDuplicate}>{t("duplicate")}</DropdownMenuItem> : null}
            {item.onAddAfter ? <DropdownMenuItem onSelect={item.onAddAfter}>{t("addSectionAfter")}</DropdownMenuItem> : null}
            {item.onRemove ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={item.onRemove}>{t("remove")}</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** One group's tree. */
function GroupTree({ group, selected, expanded, setExpanded, onSelect, onHover, onMove, announce, active, setActive }: {
  group: TreeGroupModel;
  selected: string | null;
  expanded: ReadonlySet<string>;
  setExpanded: (update: (current: Set<string>) => Set<string>) => void;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onMove: (list: string, from: number, to: number) => void;
  announce: (message: string) => void;
  active: string | null;
  setActive: (id: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const rows = useMemo(() => flatten(group.items, expanded), [group.items, expanded]);
  const elements = useRef(new Map<string, HTMLLIElement>());
  const [picked, setPicked] = useState<{ id: string; list: string; from: number } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const focusedId = rows.some((row) => row.item.id === active) ? active : rows.find((row) => row.item.id === selected)?.item.id ?? rows[0]?.item.id ?? null;
  const focus = (id: string) => {
    setActive(id);
    elements.current.get(id)?.focus();
  };

  // A row the editor selected elsewhere (the preview) comes into view, its parents open.
  useEffect(() => {
    if (!selected) return;
    elements.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);

  const move = (row: Visible, to: number) => {
    const { move: place } = row.item;
    if (!place || to < 0 || to >= place.count || to === place.index) return;
    onMove(place.list, place.index, to);
    announce(t("movedTo", { name: row.item.name, position: to + 1, count: place.count }));
  };

  const keyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = rows.findIndex((row) => row.item.id === focusedId);
    const row = rows[index];
    if (!row) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (picked) {
      // Moving a picked-up row: arrows move it, Space or Enter drops it, Esc puts it back.
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        handled();
        move(row, (row.item.move?.index ?? 0) + (event.key === "ArrowUp" ? -1 : 1));
      } else if (event.key === " " || event.key === "Enter") {
        handled();
        setPicked(null);
        announce(t("dropped", { name: row.item.name, position: (row.item.move?.index ?? 0) + 1, count: row.item.move?.count ?? 1 }));
      } else if (event.key === "Escape") {
        handled();
        if (row.item.move && row.item.move.index !== picked.from) onMove(picked.list, row.item.move.index, picked.from);
        setPicked(null);
        announce(t("cancelled", { name: row.item.name }));
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        handled();
        if (event.altKey) move(row, (row.item.move?.index ?? 0) + 1);
        else if (rows[index + 1]) focus(rows[index + 1]!.item.id);
        break;
      case "ArrowUp":
        handled();
        if (event.altKey) move(row, (row.item.move?.index ?? 0) - 1);
        else if (rows[index - 1]) focus(rows[index - 1]!.item.id);
        break;
      case "Home":
        handled();
        focus(rows[0]!.item.id);
        break;
      case "End":
        handled();
        focus(rows.at(-1)!.item.id);
        break;
      case "ArrowRight":
        if (!row.item.children?.length) break;
        handled();
        if (!expanded.has(row.item.id)) setExpanded((current) => new Set(current).add(row.item.id));
        else focus(row.item.children[0]!.id);
        break;
      case "ArrowLeft":
        handled();
        if (row.item.children?.length && expanded.has(row.item.id)) {
          setExpanded((current) => {
            const next = new Set(current);
            next.delete(row.item.id);
            return next;
          });
        } else if (row.parent) focus(row.parent);
        break;
      case "Enter":
        handled();
        if (row.item.add) row.item.add();
        else onSelect(row.item.id);
        break;
      case " ":
        if (!row.item.move) break;
        handled();
        setPicked({ id: row.item.id, list: row.item.move.list, from: row.item.move.index });
        announce(t("pickedUp", { name: row.item.name, position: row.item.move.index + 1, count: row.item.move.count }));
        break;
      case "Delete":
      case "Backspace":
        if (!row.item.onRemove) break;
        handled();
        row.item.onRemove();
        break;
      case "ContextMenu":
      case "F10":
        if (event.key === "F10" && !event.shiftKey) break;
        handled();
        setMenuFor(row.item.id);
        break;
    }
  };

  const dragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const from = rows.find((row) => row.item.id === dragged.id)?.item.move;
    const to = rows.find((row) => row.item.id === over.id)?.item.move;
    // A row moves among its own siblings only: an invalid drop returns it.
    if (!from || !to || from.list !== to.list) return;
    onMove(from.list, from.index, to.index);
  };

  const lists = new Map<string, string[]>();
  for (const row of rows) if (row.item.move) lists.set(row.item.move.list, [...(lists.get(row.item.move.list) ?? []), row.item.id]);

  const renderRows = (): ReactNode => rows.map((row) => (
    <Row
      key={row.item.id}
      entry={row}
      selected={row.item.id === selected}
      focused={row.item.id === focusedId}
      expanded={expanded.has(row.item.id)}
      picked={picked?.id === row.item.id}
      onFocusRow={() => setActive(row.item.id)}
      onSelect={() => onSelect(row.item.id)}
      onHover={(hovering) => onHover(hovering ? row.item.id : null)}
      onToggleExpanded={() => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(row.item.id)) next.delete(row.item.id);
        else next.add(row.item.id);
        return next;
      })}
      rowRef={(element) => {
        if (element) elements.current.set(row.item.id, element);
        else elements.current.delete(row.item.id);
      }}
      menuOpen={menuFor === row.item.id}
      onMenuOpenChange={(open) => setMenuFor(open ? row.item.id : null)}
      onMove={(to) => move(row, to)}
    />
  ));

  return (
    <section className="border-b border-border px-2 py-2 last:border-b-0" data-tree-group={group.id}>
      <h2 id={`tree-${group.id}`} className={cn("flex items-center gap-1.5 px-2 pb-1 pt-1 text-body font-medium", group.shared ? "text-success" : "text-muted-foreground")}>
        {group.label}
      </h2>
      {group.note ? <p role="status" className="px-2 pb-1 text-body text-muted-foreground">{group.note}</p> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
        {[...lists.entries()].reduce<ReactNode>((children, [list, ids]) => (
          <SortableContext key={list} items={ids} strategy={verticalListSortingStrategy}>{children}</SortableContext>
        ), (
          <ul role="tree" aria-labelledby={`tree-${group.id}`} className="space-y-0.5" onKeyDown={keyDown}>
            {renderRows()}
          </ul>
        ))}
      </DndContext>
    </section>
  );
}

export function LayerTree({ groups, selected, onSelect, onHover, onMove, expandTo }: {
  groups: readonly TreeGroupModel[];
  selected: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onMove: (list: string, from: number, to: number) => void;
  /** Rows to open so the selection shows (a block's section). */
  expandTo: readonly string[];
}) {
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set(expandTo));
  const [active, setActive] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const expandKey = expandTo.join(",");
  useEffect(() => {
    if (expandTo.length === 0) return;
    setExpandedState((current) => (expandTo.every((id) => current.has(id)) ? current : new Set([...current, ...expandTo])));
  }, [expandKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the list's contents, not its identity
  return (
    <div data-layer-tree>
      {groups.map((group) => (
        <GroupTree
          key={group.id}
          group={group}
          selected={selected}
          expanded={expanded}
          setExpanded={(update) => setExpandedState((current) => update(current))}
          onSelect={onSelect}
          onHover={onHover}
          onMove={onMove}
          announce={setLive}
          active={active}
          setActive={setActive}
        />
      ))}
      <p className="sr-only" role="status" aria-live="assertive">{live}</p>
    </div>
  );
}
