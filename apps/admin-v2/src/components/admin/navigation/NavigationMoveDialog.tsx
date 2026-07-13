import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CornerDownRight } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { findNavigationLocation } from "./navigation-workspace";
import {
  getNavigationItemLabel,
  getNavigationSubtreeDepth,
  MAX_NAV_DEPTH,
  type NavigationItem,
} from "./types";

const TOP_LEVEL_VALUE = "__navigation_top_level__";

export interface NavigationMoveDialogProps {
  open: boolean;
  itemId: string;
  items: NavigationItem[];
  onOpenChange: (open: boolean) => void;
  onMove: (itemId: string, parentId: string | null, index: number) => void;
}

export interface NavigationMoveParentOption {
  parentId: string | null;
  label: string;
  /** The resulting one-based level of the moving branch root. */
  level: number;
}

export interface NavigationMoveModel {
  itemLabel: string;
  initialParentId: string | null;
  initialPosition: number;
  parentOptions: NavigationMoveParentOption[];
}

/**
 * Build valid placement choices without mutating the menu. A possible parent
 * is omitted when it is the moving branch, sits inside that branch, or cannot
 * contain the branch within the public menu depth limit.
 */
export function buildNavigationMoveModel(
  items: NavigationItem[],
  itemId: string,
  maxDepth = MAX_NAV_DEPTH,
): NavigationMoveModel | null {
  const source = findNavigationLocation(items, itemId);
  if (!source) return null;

  const movingSubtreeDepth = getNavigationSubtreeDepth(source.item);
  const parentOptions: NavigationMoveParentOption[] = [
    { parentId: null, label: "Top level", level: 1 },
  ];

  const visit = (
    siblings: NavigationItem[],
    depth: number,
    path: string[],
  ) => {
    for (const item of siblings) {
      // Skipping the whole branch excludes both the moving item and every
      // descendant without relying on labels or array position.
      if (item.id === itemId) continue;

      const nextPath = [...path, getNavigationItemLabel(item)];
      const resultingLevel = depth + 2;
      if (depth + 1 + movingSubtreeDepth <= maxDepth) {
        parentOptions.push({
          parentId: item.id,
          label: nextPath.join(" › "),
          level: resultingLevel,
        });
      }
      visit(item.subMenu ?? [], depth + 1, nextPath);
    }
  };

  visit(items, 0, []);

  return {
    itemLabel: getNavigationItemLabel(source.item),
    initialParentId: source.parentId,
    initialPosition: source.index + 1,
    parentOptions,
  };
}

/** Number of valid one-based positions after the moving item is removed. */
export function getNavigationMovePositionCount(
  items: NavigationItem[],
  itemId: string,
  parentId: string | null,
): number {
  const siblings = parentId
    ? findNavigationLocation(items, parentId)?.item.subMenu ?? []
    : items;
  return siblings.filter((item) => item.id !== itemId).length + 1;
}

export function NavigationMoveDialog({
  open,
  itemId,
  items,
  onOpenChange,
  onMove,
}: NavigationMoveDialogProps) {
  const model = useMemo(
    () => buildNavigationMoveModel(items, itemId),
    [itemId, items],
  );
  const [parentId, setParentId] = useState<string | null>(null);
  const [position, setPosition] = useState(1);

  useEffect(() => {
    if (!open || !model) return;
    setParentId(model.initialParentId);
    setPosition(model.initialPosition);
  }, [model, open]);

  const positionCount = getNavigationMovePositionCount(items, itemId, parentId);
  const selectedParent = model?.parentOptions.find(
    (option) => option.parentId === parentId,
  );
  const parentIsValid = Boolean(selectedParent);

  useEffect(() => {
    setPosition((current) => Math.min(Math.max(current, 1), positionCount));
  }, [positionCount]);

  const parentChoices = useMemo(
    () => model?.parentOptions.map((option) => ({
      value: option.parentId ?? TOP_LEVEL_VALUE,
      label: option.label,
      keywords: option.parentId ? [option.parentId] : ["root"],
    })) ?? [],
    [model],
  );

  function handleParentChange(value: string) {
    const nextParentId = value === TOP_LEVEL_VALUE ? null : value;
    const nextPositionCount = getNavigationMovePositionCount(
      items,
      itemId,
      nextParentId,
    );
    setParentId(nextParentId);
    setPosition((current) => Math.min(Math.max(current, 1), nextPositionCount));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!model || !selectedParent) return;

    onMove(itemId, parentId, position - 1);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-base">
            Move {model?.itemLabel ?? "menu item"}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Choose its parent and exact position. The complete branch moves together.
          </DialogDescription>
        </DialogHeader>

        <form method="post" onSubmit={handleSubmit}>
          <div className="grid gap-4 px-5 py-4">
            {model ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="navigation-move-parent">Parent</Label>
                  <SearchableSelect
                    id="navigation-move-parent"
                    value={parentId ?? TOP_LEVEL_VALUE}
                    onValueChange={handleParentChange}
                    options={parentChoices}
                    ariaLabel={`Parent for ${model.itemLabel}`}
                    placeholder="Choose a parent"
                    searchPlaceholder="Find a parent..."
                    emptyMessage="No parent matches this search."
                    triggerClassName="w-full"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="navigation-move-position">Position</Label>
                  <Select
                    value={String(position)}
                    onValueChange={(value) => setPosition(Number(value))}
                  >
                    <SelectTrigger
                      id="navigation-move-position"
                      aria-label={`Position for ${model.itemLabel}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: positionCount }, (_, index) => {
                        const value = index + 1;
                        return (
                          <SelectItem key={value} value={String(value)}>
                            {value}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                <div
                  className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2.5"
                  aria-live="polite"
                >
                  <CornerDownRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="min-w-0 truncate text-sm">
                    <span className="font-medium">
                      {selectedParent?.label ?? "Unavailable parent"}
                    </span>
                    <span className="text-muted-foreground">
                      {` · Level ${selectedParent?.level ?? "—"} · Position ${position} of ${positionCount}`}
                    </span>
                  </p>
                </div>
              </>
            ) : (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                This menu item is no longer available. Close the dialog and try again.
              </p>
            )}
          </div>

          <DialogFooter className="border-t px-5 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!model || !parentIsValid}>
              Move item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
