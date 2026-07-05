import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Filter, X } from "lucide-react";
import { DataTableToolbar } from "./DataTableToolbar";
import type { DiscountTypeFilterMenuProps } from "./DiscountTypeFilterMenu";
import { getTypeLabel } from "./columns/discount-columns";

interface DiscountTableToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedCount: number;
  bulkActions?: ReactNode;
  actions?: ReactNode;
  activeType: string | null;
  onTypeFilterChange: (type: string | null) => void;
}

const LazyDiscountTypeFilterMenu = lazy(async () => {
  const module = await import("./DiscountTypeFilterMenu");
  return {
    default: module.DiscountTypeFilterMenu as ComponentType<
      DiscountTypeFilterMenuProps
    >,
  };
});

function isMenuOpenKey(key: string) {
  return key === "Enter" || key === " " || key === "ArrowDown";
}

export function DiscountTableToolbar({
  searchValue,
  onSearchChange,
  selectedCount,
  bulkActions,
  actions,
  activeType,
  onTypeFilterChange,
}: DiscountTableToolbarProps) {
  const [isTypeMenuRequested, setIsTypeMenuRequested] = useState(false);
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);

  const requestTypeMenuOpen = useCallback(() => {
    setIsTypeMenuRequested(true);
    setIsTypeMenuOpen(true);
  }, []);

  const handleTypeMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setIsTypeMenuRequested(true);
    }
    setIsTypeMenuOpen(open);
  }, []);

  const handleTypeTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isMenuOpenKey(event.key)) {
        return;
      }

      event.preventDefault();
      requestTypeMenuOpen();
    },
    [requestTypeMenuOpen],
  );

  const typeFilterTrigger = (
    <Button
      variant="outline"
      size="sm"
      className="h-9"
      data-state={isTypeMenuOpen ? "open" : undefined}
      aria-haspopup="menu"
      aria-expanded={isTypeMenuOpen}
      onClick={isTypeMenuRequested ? undefined : requestTypeMenuOpen}
      onKeyDown={isTypeMenuRequested ? undefined : handleTypeTriggerKeyDown}
    >
      <Filter className="h-4 w-4 mr-1.5" />
      Type
      {activeType ? (
        <span className="ml-1.5 text-xs text-muted-foreground">(1)</span>
      ) : null}
    </Button>
  );

  const typeFilter = (
    <div className="flex items-center gap-2">
      {isTypeMenuRequested ? (
        <Suspense fallback={typeFilterTrigger}>
          <LazyDiscountTypeFilterMenu
            open={isTypeMenuOpen}
            onOpenChange={handleTypeMenuOpenChange}
            trigger={typeFilterTrigger}
            activeType={activeType}
            onTypeFilterChange={onTypeFilterChange}
          />
        </Suspense>
      ) : (
        typeFilterTrigger
      )}
      {activeType ? (
        <Badge
          variant="secondary"
          className="rounded-md px-2 py-0.5 text-xs"
        >
          Type: {getTypeLabel(activeType)}
          <button
            onClick={() => onTypeFilterChange(null)}
            className="ml-1 rounded-full hover:bg-background p-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Clear type filter"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ) : null}
    </div>
  );

  return (
    <DataTableToolbar
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search by code..."
      selectedCount={selectedCount}
      bulkActions={bulkActions}
      filters={typeFilter}
      actions={actions}
    />
  );
}
