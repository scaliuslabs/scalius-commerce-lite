import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  CornerDownRight,
  LoaderCircle,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import {
  getNavigationMenuMoveOptionsAuthority,
  type NavigationMenuItemRow,
  type NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";

interface NavigationAuthorityMoveDialogProps {
  open: boolean;
  menu: NavigationMenuSummary;
  item: NavigationMenuItemRow;
  moving: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (destination: { parentId: string | null; index: number }) => void;
}

export function NavigationAuthorityMoveDialog({
  open,
  menu,
  item,
  moving,
  onOpenChange,
  onMove,
}: NavigationAuthorityMoveDialogProps) {
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [parentQuery, setParentQuery] = useState("");
  const [debouncedParentQuery, setDebouncedParentQuery] = useState("");
  const [selectedParentId, setSelectedParentId] = useState<string | null | undefined>(undefined);
  const [position, setPosition] = useState(1);

  useEffect(() => {
    if (!open) return;
    setParentPickerOpen(false);
    setParentQuery("");
    setDebouncedParentQuery("");
    setSelectedParentId(undefined);
    setPosition(1);
  }, [item.id, open]);

  useEffect(() => {
    const normalized = parentQuery.trim();
    const timer = window.setTimeout(() => {
      setDebouncedParentQuery(normalized.length >= 2 ? normalized : "");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [parentQuery]);

  const optionsQuery = useQuery({
    queryKey: [
      "navigation",
      "move-options",
      menu.id,
      menu.revision,
      item.id,
      selectedParentId,
      debouncedParentQuery,
    ],
    queryFn: () => getNavigationMenuMoveOptionsAuthority({
      data: {
        menuId: menu.id,
        itemId: item.id,
        query: debouncedParentQuery || undefined,
        limit: 50,
        selectedParentId,
      },
    }),
    enabled: open,
    staleTime: 15_000,
  });
  const options = optionsQuery.data;

  useEffect(() => {
    if (!options) return;
    if (selectedParentId === undefined) {
      setSelectedParentId(options.selectedParentId);
      setPosition(options.currentPosition);
      return;
    }
    setPosition((current) => Math.min(Math.max(current, 1), options.positionCount));
  }, [options, selectedParentId]);

  const selectedParent = useMemo(
    () => options?.parents.find((candidate) => candidate.id === selectedParentId),
    [options?.parents, selectedParentId],
  );
  const parentLabel = selectedParentId === null
    ? "Top level"
    : selectedParent?.pathLabel ?? "Choose a parent";
  const resultingLevel = selectedParentId === null ? 1 : selectedParent?.resultingLevel;
  const positionCount = options?.positionCount ?? 1;

  function chooseParent(parentId: string | null) {
    setSelectedParentId(parentId);
    setPosition(1);
    setParentPickerOpen(false);
    setParentQuery("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedParentId === undefined || !options || moving) return;
    onMove({ parentId: selectedParentId, index: position - 1 });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !moving && onOpenChange(nextOpen)}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
          <DialogTitle className="text-base">Move {item.label}</DialogTitle>
          <DialogDescription className="text-xs">
            Choose an exact parent and position. The whole branch moves together.
          </DialogDescription>
        </DialogHeader>

        <form method="post" onSubmit={submit}>
          <div className="grid gap-4 px-5 py-4">
            <div className="grid gap-1.5">
              <Label>Parent</Label>
              <Popover open={parentPickerOpen} onOpenChange={setParentPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-label={`Parent for ${item.label}`}
                    aria-expanded={parentPickerOpen}
                    disabled={moving}
                    className="h-9 min-w-0 justify-between px-3 font-normal"
                  >
                    <span className="truncate">{parentLabel}</span>
                    <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={16}
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command shouldFilter={false}>
                    <CommandInput
                      value={parentQuery}
                      onValueChange={setParentQuery}
                      placeholder="Find a parent…"
                    />
                    <CommandList className="max-h-72">
                      {optionsQuery.isError ? (
                        <div role="alert" className="m-2 rounded-md border border-destructive/30 p-3 text-sm">
                          <p className="text-destructive">Parent choices could not be loaded.</p>
                          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void optionsQuery.refetch()}>
                            Retry
                          </Button>
                        </div>
                      ) : null}
                      <CommandGroup>
                        <CommandItem value="top-level" onSelect={() => chooseParent(null)}>
                          <Check className={cn("mr-2 size-4", selectedParentId === null ? "opacity-100" : "opacity-0")} />
                          Top level
                        </CommandItem>
                        {options?.parents.map((parent) => (
                          <CommandItem key={parent.id} value={parent.id} onSelect={() => chooseParent(parent.id)}>
                            <Check className={cn("mr-2 size-4", selectedParentId === parent.id ? "opacity-100" : "opacity-0")} />
                            <span className="min-w-0 flex-1 truncate">{parent.pathLabel}</span>
                            <span className="ml-2 shrink-0 text-xs text-muted-foreground">Level {parent.resultingLevel}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                      {optionsQuery.isLoading ? (
                        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                          <LoaderCircle className="size-4 animate-spin" /> Loading…
                        </div>
                      ) : (
                        <CommandEmpty>No valid parent found.</CommandEmpty>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="navigation-authority-move-position">Position</Label>
              <Input
                id="navigation-authority-move-position"
                type="number"
                inputMode="numeric"
                min={1}
                max={positionCount}
                value={position}
                disabled={moving || !options}
                onChange={(event) => setPosition(Number(event.target.value) || 1)}
                onBlur={() => setPosition((current) => Math.min(Math.max(current, 1), positionCount))}
                aria-label={`Position for ${item.label}`}
              />
            </div>

            <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2.5" aria-live="polite">
              <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 truncate text-sm">
                <span className="font-medium">{parentLabel}</span>
                <span className="text-muted-foreground">
                  {` · Level ${resultingLevel ?? "—"} · Position ${position} of ${positionCount}`}
                </span>
              </p>
            </div>
          </div>

          <DialogFooter className="border-t px-5 py-3">
            <Button type="button" variant="outline" disabled={moving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!options || selectedParentId === undefined || moving}>
              {moving ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              Move item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
