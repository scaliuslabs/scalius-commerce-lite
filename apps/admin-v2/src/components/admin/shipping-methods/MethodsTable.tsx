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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

function MethodActions({
  method,
  showTrashed,
  mobile = false,
  onEdit,
  onDelete,
  onRestore,
}: Pick<MethodRowProps, "method" | "showTrashed" | "onEdit" | "onDelete" | "onRestore"> & {
  mobile?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={mobile ? "h-11 w-11" : "h-7 w-7"}
          aria-label={`Actions for ${method.name}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
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
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete permanently
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
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Move to trash
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
        <Badge variant={method.isActive ? "default" : "secondary"}>
          {method.isActive ? "Active" : "Inactive"}
        </Badge>
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {method.sortOrder}
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {formatDate(method.updatedAt)}
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <MethodActions
          method={method}
          showTrashed={showTrashed}
          onEdit={onEdit}
          onDelete={onDelete}
          onRestore={onRestore}
        />
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
      <div className="space-y-3 p-2 md:hidden">
        <div className="flex items-center gap-2">
          <Select value={sort.field} onValueChange={(field) => onSort(field as SortField)}>
            <SelectTrigger className="h-11 flex-1" aria-label="Sort shipping methods by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="fee">Fee</SelectItem>
              <SelectItem value="isActive">Status</SelectItem>
              <SelectItem value="sortOrder">Order</SelectItem>
              <SelectItem value="createdAt">Created</SelectItem>
              <SelectItem value="updatedAt">Last updated</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0"
            aria-label={`Sort ${sort.order === "asc" ? "descending" : "ascending"}`}
            onClick={() => onSort(sort.field)}
          >
            {sort.order === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
          </Button>
        </div>

        {methods.length > 0 && !isLoading ? (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-dashed px-3 text-sm text-muted-foreground">
            <Checkbox
              checked={selectAllCheckedState}
              onCheckedChange={onToggleAll}
              aria-label="Select all methods"
            />
            Select all {methods.length} on this page
          </label>
        ) : null}

        {isLoading ? (
          <div className="flex h-32 items-center justify-center" role="status" aria-label="Loading shipping methods">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : methods.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
            <Truck className="h-8 w-8 text-muted-foreground/50" />
            <p className="font-medium text-muted-foreground">
              {hasActiveFilters ? "No methods match your filters." : showTrashed ? "Trash is empty." : "No shipping methods yet."}
            </p>
            {!showTrashed && !hasActiveFilters ? (
              <Button onClick={onCreateFirst} className="min-h-11">
                <Plus className="mr-1.5 h-4 w-4" /> Add shipping method
              </Button>
            ) : null}
          </div>
        ) : (
          methods.map((method) => {
            const selected = selectedMethods.has(method.id);
            return (
              <article key={method.id} className={cn("rounded-xl border bg-background p-3", selected && "border-primary bg-muted/40")}>
                <div className="flex items-start justify-between gap-2">
                  <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(checked) => onToggleSelection(method.id, !!checked)}
                      aria-label={`Select ${method.name}`}
                    />
                    <span className="min-w-0 break-words font-medium">{method.name}</span>
                  </label>
                  <MethodActions
                    method={method}
                    showTrashed={showTrashed}
                    mobile
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onRestore={onRestore}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge variant={method.isActive ? "default" : "secondary"}>{method.isActive ? "Active" : "Inactive"}</Badge>
                  <span className="text-sm font-medium">{symbol}{method.fee.toLocaleString()}</span>
                </div>
                {method.description ? <p className="mt-3 break-words text-sm text-muted-foreground">{method.description}</p> : null}
                <dl className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-xs">
                  <div><dt className="text-muted-foreground">Order</dt><dd className="mt-1 font-medium">{method.sortOrder}</dd></div>
                  <div><dt className="text-muted-foreground">Last updated</dt><dd className="mt-1 font-medium">{formatDate(method.updatedAt)}</dd></div>
                </dl>
              </article>
            );
          })
        )}
      </div>

      <div className="hidden md:block">
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
    </div>
  );
}
