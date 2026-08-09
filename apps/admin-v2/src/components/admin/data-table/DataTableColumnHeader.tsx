import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import type { Column, TableRowData } from "./table-config";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { DataTableColumnHeaderMenuProps } from "./DataTableColumnHeaderMenu";

interface DataTableColumnHeaderProps<TData extends TableRowData, TValue> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

const LazyDataTableColumnHeaderMenu = lazy(async () => {
  const module = await import("./DataTableColumnHeaderMenu");
  return {
    default: module.DataTableColumnHeaderMenu as ComponentType<
      DataTableColumnHeaderMenuProps<TableRowData, unknown>
    >,
  };
});

function isMenuOpenKey(key: string) {
  return key === "Enter" || key === " " || key === "ArrowDown";
}

function DataTableColumnHeaderInner<TData extends TableRowData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  const [isMenuRequested, setIsMenuRequested] = useState(false);
  const [open, setOpen] = useState(false);

  const requestMenuOpen = useCallback(() => {
    setIsMenuRequested(true);
    setOpen(true);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setIsMenuRequested(true);
    }
    setOpen(nextOpen);
  }, []);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isMenuOpenKey(event.key)) {
        return;
      }

      event.preventDefault();
      requestMenuOpen();
    },
    [requestMenuOpen],
  );

  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }

  const sorted = column.getIsSorted();

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 data-[state=open]:bg-accent"
      data-state={open ? "open" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={isMenuRequested ? undefined : requestMenuOpen}
      onKeyDown={isMenuRequested ? undefined : handleTriggerKeyDown}
    >
      <span>{title}</span>
      {sorted === "desc" ? (
        <ArrowDown className="ml-2 h-4 w-4" />
      ) : sorted === "asc" ? (
        <ArrowUp className="ml-2 h-4 w-4" />
      ) : (
        <ArrowUpDown className="ml-2 h-4 w-4" />
      )}
    </Button>
  );

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      {isMenuRequested ? (
        <Suspense fallback={trigger}>
          <LazyDataTableColumnHeaderMenu
            column={column as unknown as Column<TableRowData, unknown>}
            open={open}
            onOpenChange={handleOpenChange}
            trigger={trigger}
          />
        </Suspense>
      ) : (
        trigger
      )}
    </div>
  );
}

export const DataTableColumnHeader = memo(DataTableColumnHeaderInner) as typeof DataTableColumnHeaderInner;
