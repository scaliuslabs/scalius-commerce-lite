import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
  Plus,
  Loader2,
  Undo,
  Truck,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import type { ShippingMethod, SortField, SortOrder } from "./hooks/useShippingMethods";

function getSortIcon(sort: { field: SortField; order: SortOrder }, field: SortField) {
  if (sort.field !== field)
    return <ArrowUpDown className="ml-1 h-3.5 w-3.5 inline" />;
  return sort.order === "asc" ? (
    <ArrowUp className="ml-1 h-3.5 w-3.5 inline" />
  ) : (
    <ArrowDown className="ml-1 h-3.5 w-3.5 inline" />
  );
}

interface MethodRowProps {
  method: ShippingMethod;
  symbol: string;
  isSelected: boolean;
  showTrashed: boolean;
  onToggleSelection: (id: string, checked: boolean) => void;
  onEdit: (method: ShippingMethod) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}

const MethodRow = React.memo(function MethodRow({
  method,
  symbol,
  isSelected,
  showTrashed,
  onToggleSelection,
  onEdit,
  onDelete,
  onRestore,
}: MethodRowProps) {
  return (
    <TableRow
      className={cn(
        "hover:bg-muted/50 transition-colors",
        isSelected && "bg-muted",
      )}
      data-state={isSelected ? "selected" : undefined}
    >
      <TableCell className="pl-3 pr-1 py-2">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) =>
            onToggleSelection(method.id, !!checked)
          }
          aria-label={`Select ${method.name}`}
          className="h-3.5 w-3.5"
        />
      </TableCell>
      <TableCell className="py-2 text-sm font-medium text-foreground">
        {method.name}
      </TableCell>
      <TableCell className="py-2 text-xs">
        {symbol}{method.fee.toLocaleString()}
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground truncate max-w-xs">
        {method.description || "-"}
      </TableCell>
      <TableCell className="py-2 text-xs">
        <span
          className={cn(
            "px-2 py-0.5 rounded-full text-xs font-medium",
            method.isActive
              ? "bg-green-100 text-green-700"
              : "bg-red-100 text-red-700",
          )}
        >
          {method.isActive ? "Active" : "Inactive"}
        </span>
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {method.sortOrder}
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {formatDate(method.updatedAt)}
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[170px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem onClick={() => onRestore(method.id)}>
                  <Undo className="mr-2 h-3.5 w-3.5" />
                  Restore
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(method.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete Permanently
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => onEdit(method)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onDelete(method.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Move to Trash
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

interface MethodsTableProps {
  methods: ShippingMethod[];
  symbol: string;
  isLoading: boolean;
  showTrashed: boolean;
  hasActiveFilters: boolean;
  sort: { field: SortField; order: SortOrder };
  selectedMethods: Set<string>;
  selectAllCheckedState: boolean | "indeterminate";
  onSort: (field: SortField) => void;
  onEdit: (method: ShippingMethod) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onToggleSelection: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean | "indeterminate") => void;
  onCreateFirst: () => void;
}

export function MethodsTable({
  methods,
  symbol,
  isLoading,
  showTrashed,
  hasActiveFilters,
  sort,
  selectedMethods,
  selectAllCheckedState,
  onSort,
  onEdit,
  onDelete,
  onRestore,
  onToggleSelection,
  onToggleAll,
  onCreateFirst,
}: MethodsTableProps) {
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-10 pl-3 pr-1 py-2">
              <Checkbox
                checked={selectAllCheckedState}
                onCheckedChange={onToggleAll}
                aria-label="Select all methods"
                disabled={methods.length === 0}
                className="h-3.5 w-3.5"
              />
            </TableHead>
            <TableHead className="py-2 text-xs">
              <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-7 text-xs" onClick={() => onSort("name")}>
                Name {getSortIcon(sort, "name")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">
              <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-7 text-xs" onClick={() => onSort("fee")}>
                Fee {getSortIcon(sort, "fee")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">Description</TableHead>
            <TableHead className="py-2 text-xs">
              <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-7 text-xs" onClick={() => onSort("isActive")}>
                Status {getSortIcon(sort, "isActive")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">
              <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-7 text-xs" onClick={() => onSort("sortOrder")}>
                Order {getSortIcon(sort, "sortOrder")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">
              <Button variant="ghost" className="px-0 hover:bg-transparent -ml-1 h-7 text-xs" onClick={() => onSort("updatedAt")}>
                Last Updated {getSortIcon(sort, "updatedAt")}
              </Button>
            </TableHead>
            <TableHead className="w-[70px] text-right pr-3 py-2 text-xs">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
              </TableCell>
            </TableRow>
          )}
          {!isLoading && methods.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <div className="flex flex-col items-center justify-center gap-1.5">
                  <Truck className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-base font-medium text-muted-foreground">
                    {hasActiveFilters
                      ? "No methods match criteria."
                      : showTrashed
                        ? "Trash is empty."
                        : "No shipping methods yet."}
                  </p>
                  {!showTrashed && !hasActiveFilters && (
                    <Button size="sm" onClick={onCreateFirst} className="mt-1 h-7 text-xs">
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add First Method
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            methods.map((method) => (
              <MethodRow
                key={method.id}
                method={method}
                symbol={symbol}
                isSelected={selectedMethods.has(method.id)}
                showTrashed={showTrashed}
                onToggleSelection={onToggleSelection}
                onEdit={onEdit}
                onDelete={onDelete}
                onRestore={onRestore}
              />
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
