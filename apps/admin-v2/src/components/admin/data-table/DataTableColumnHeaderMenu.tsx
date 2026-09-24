import { useContext, type ReactNode } from "react";
import type { Column, TableRowData } from "./table-config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowDown, ArrowUp, EyeOff } from "lucide-react";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import { isPrimaryColumn } from "./column-layout";
import { ColumnLayoutContext, columnLabel } from "./DataTableColumnMenu";

export interface DataTableColumnHeaderMenuProps<
  TData extends TableRowData,
  TValue,
> {
  column: Column<TData, TValue>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
}

/**
 * A sortable column heading's menu: sort either way, and hide the column
 * through the list's column layout (so "Sort and columns" can show it again).
 */
export function DataTableColumnHeaderMenu<
  TData extends TableRowData,
  TValue,
>({
  column,
  open,
  onOpenChange,
  trigger,
}: DataTableColumnHeaderMenuProps<TData, TValue>) {
  const t = useMessages(dataTableMessages);
  const layout = useContext(ColumnLayoutContext);
  const name = columnLabel(column as Column<TData, unknown>);
  const canHide = Boolean(layout) && !isPrimaryColumn(column as Column<TData, unknown>);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => column.toggleSorting(false)}>
          <ArrowUp className="text-muted-foreground" aria-hidden />
          {t("sortAscending")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => column.toggleSorting(true)}>
          <ArrowDown className="text-muted-foreground" aria-hidden />
          {t("sortDescending")}
        </DropdownMenuItem>
        {canHide ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => layout?.toggle(column.id)}>
              <EyeOff className="text-muted-foreground" aria-hidden />
              {t("hideColumn", { name })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
