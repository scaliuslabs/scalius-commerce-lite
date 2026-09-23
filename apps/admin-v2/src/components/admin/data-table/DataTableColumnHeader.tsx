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
  const numeric = Boolean(column.columnDef.meta?.numeric);

  // Polaris IndexTable heading: the same caption type as a plain heading,
  // with the sort arrow beside it; the whole label is the button.
  const trigger = (
    <button
      type="button"
      className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground"
      data-state={open ? "open" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={isMenuRequested ? undefined : requestMenuOpen}
      onKeyDown={isMenuRequested ? undefined : handleTriggerKeyDown}
    >
      <span>{title}</span>
      {sorted === "desc" ? (
        <ArrowDown className="size-3.5" aria-hidden />
      ) : sorted === "asc" ? (
        <ArrowUp className="size-3.5" aria-hidden />
      ) : (
        <ArrowUpDown className="size-3.5 opacity-60" aria-hidden />
      )}
    </button>
  );

  return (
    <div className={cn("flex items-center", numeric && "justify-end", className)}>
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
