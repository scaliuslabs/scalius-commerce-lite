import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@scalius/shared/utils";
import { getWidgetPlacementTargets } from "@/lib/api-functions/widgets";
import { queryKeys } from "@/lib/query-keys";
import type { WidgetPlacementTargetOption } from "@/types/api-responses";

type WidgetTargetType = WidgetPlacementTargetOption["type"];

interface WidgetTargetSelectProps {
  targetType: WidgetTargetType;
  value?: string | null;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
}

export function WidgetTargetSelect({
  targetType,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
}: WidgetTargetSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setSearch("");
    setDebouncedSearch("");
  }, [targetType]);

  const selectedIds = useMemo(() => (value ? [value] : []), [value]);
  const queryParams = useMemo(
    () => ({
      targetType,
      search: debouncedSearch,
      selectedId: value ?? "",
      limit: 30,
    }),
    [debouncedSearch, targetType, value],
  );

  const { data, isFetching, isLoading } = useQuery({
    queryKey: queryKeys.widgets.placementTargets(queryParams),
    queryFn: () =>
      getWidgetPlacementTargets({
        data: {
          type: targetType,
          search: debouncedSearch || undefined,
          ids: selectedIds,
          limit: 30,
        },
      }),
    enabled: open || !!value,
    staleTime: 1000 * 60 * 5,
  });

  const options = data?.targets ?? [];
  const selectedOption = options.find((option) => option.id === value);
  const isSelectedTargetUnavailable = Boolean(value && !isLoading && !selectedOption);
  const selectedLabel = selectedOption
    ? selectedOption.description
      ? `${selectedOption.label} (${selectedOption.description})`
      : selectedOption.label
    : value
      ? isLoading
        ? "Loading target..."
        : "Target unavailable"
      : placeholder;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-10 w-full justify-between px-3 font-normal",
            !value && "text-muted-foreground",
            isSelectedTargetUnavailable && "border-destructive/50 text-destructive",
          )}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        sideOffset={6}
        className="max-h-[--radix-popover-content-available-height] w-[min(max(var(--radix-popover-trigger-width),22rem),calc(100vw-2rem))] p-0"
      >
        <Command shouldFilter={false}>
          {isSelectedTargetUnavailable && (
            <div className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
              Saved target is unavailable. Choose another target.
            </div>
          )}
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder ?? placeholder}
            className="h-10"
          />
          <CommandList>
            {isLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading targets...
              </div>
            ) : (
              <>
                <CommandEmpty>
                  <div className="px-3 py-4 text-sm text-muted-foreground">
                    No matching targets.
                  </div>
                </CommandEmpty>
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option.id}
                      value={`${option.type}:${option.id}:${option.label}`}
                      onSelect={() => {
                        onChange(option.id);
                        setOpen(false);
                        setSearch("");
                      }}
                      className="cursor-pointer"
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          value === option.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                        {option.description ? (
                          <span className="ml-1 text-muted-foreground">
                            ({option.description})
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                {isFetching && !isLoading ? (
                  <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Refreshing...
                  </div>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
