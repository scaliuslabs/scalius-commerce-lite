import React, { useCallback } from "react";
import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Clock,
  ExternalLink,
  Mail,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  ShoppingBag,
  Trash2,
  Undo,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import type { Customer, SortField } from "./hooks/useCustomerListState";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";

interface CustomerTableProps {
  customers: Customer[];
  selectedCustomers: Set<string>;
  selectAllCheckedState: boolean | "indeterminate";
  sort: { field: SortField; order: "asc" | "desc" };
  showTrashed: boolean;
  isProcessing: boolean;
  localSearch: string;
  symbol: string;
  onToggleAll: () => void;
  onToggleSelection: (id: string) => void;
  onSort: (field: SortField) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onSetDialog: (state: { action: "delete" | "bulk-delete"; id?: string }) => void;
}

// formatDate uses shared utility (date-only format)

function formatLocation(customer: Customer): string {
  const parts = [
    customer.address,
    customer.areaName,
    customer.zoneName,
    customer.cityName,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "\u2014";
}

const CustomerRow = React.memo(function CustomerRow({
  customer,
  isSelected,
  showTrashed,
  isProcessing,
  symbol,
  onToggleSelection,
  onRestore,
  onSetDialog,
}: {
  customer: Customer;
  isSelected: boolean;
  showTrashed: boolean;
  isProcessing: boolean;
  symbol: string;
  onToggleSelection: (id: string) => void;
  onRestore: (id: string) => void;
  onSetDialog: (state: { action: "delete" | "bulk-delete"; id?: string }) => void;
}) {
  const location = formatLocation(customer);

  return (
    <TableRow
      data-state={isSelected ? "selected" : undefined}
      data-admin-list-row=""
    >
      <TableCell className="px-4">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection(customer.id)}
          aria-label={`Select ${customer.name}`}
        />
      </TableCell>
      <TableCell className="font-medium">
        <div className="flex flex-col">
          <Link
            to={`/admin/customers/${customer.id}/history` as string}
            className="text-primary hover:underline flex items-center gap-1.5 w-fit"
          >
            {customer.name}
            <ExternalLink className="h-3.5 w-3.5 opacity-50" />
          </Link>
          <div className="text-xs text-muted-foreground mt-1 space-y-1">
            <div className="flex items-center gap-2">
              <Phone className="h-3 w-3" />
              <span>{formatPhoneForDisplay(customer.phone)}</span>
            </div>
            {customer.email ? (
              <div className="flex items-center gap-2">
                <Mail className="h-3 w-3" />
                <span>{customer.email}</span>
              </div>
            ) : null}
            {location ? (
              <div className="flex items-start gap-2">
                <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                <span className="line-clamp-1">{location}</span>
              </div>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-sm">
          <ShoppingBag className="h-4 w-4 text-muted-foreground" />
          {customer.totalOrders}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{symbol}</span>
          {customer.totalSpent.toLocaleString()}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          {formatDate(customer.lastOrderAt)}
        </div>
      </TableCell>
      <TableCell className="text-right pr-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem
                  onClick={() => onRestore(customer.id)}
                  disabled={isProcessing}
                >
                  <Undo className="mr-2 h-4 w-4" />
                  <span>Restore Customer</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() =>
                    onSetDialog({ action: "delete", id: customer.id })
                  }
                  disabled={isProcessing}
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  <span>Delete Permanently</span>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem asChild>
                  <Link to={`/admin/customers/${customer.id}/edit` as string}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit Customer
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() =>
                    onSetDialog({ action: "delete", id: customer.id })
                  }
                  disabled={isProcessing}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Move to Trash</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

function EmptyState({
  localSearch,
  showTrashed,
}: {
  localSearch: string;
  showTrashed: boolean;
}) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="h-48 text-center">
        <div className="flex flex-col items-center justify-center gap-2">
          <Users className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-lg font-medium text-muted-foreground">
            {localSearch.trim()
              ? "No Customers Match Your Search"
              : showTrashed
                ? "Trash is Empty"
                : "No Customers Found"}
          </p>
          <p className="text-sm text-muted-foreground">
            {localSearch.trim()
              ? "Try adjusting your search query."
              : showTrashed
                ? "Deleted customer records will appear here."
                : "Add a new customer or sync from your orders."}
          </p>
          <div className="flex gap-2 mt-2">
            <Button size="sm" asChild>
              <Link to="/admin/customers/new">
                <UserPlus className="mr-2 h-4 w-4" /> Add Customer
              </Link>
            </Button>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function CustomerTable({
  customers,
  selectedCustomers,
  selectAllCheckedState,
  sort,
  showTrashed,
  isProcessing,
  localSearch,
  symbol,
  onToggleAll,
  onToggleSelection,
  onSort,
  onDelete: _onDelete,
  onRestore,
  onSetDialog,
}: CustomerTableProps) {
  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field)
        return (
          <ArrowUpDown className="ml-1.5 h-3 w-3 text-muted-foreground/70" />
        );
      return sort.order === "asc" ? (
        <ArrowUp className="ml-1.5 h-3 w-3" />
      ) : (
        <ArrowDown className="ml-1.5 h-3 w-3" />
      );
    },
    [sort],
  );

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-12 px-4">
              <Checkbox
                checked={selectAllCheckedState}
                onCheckedChange={onToggleAll}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead className="min-w-[250px]">
              <Button
                variant="ghost"
                className="px-1 -ml-1"
                onClick={() => onSort("name")}
              >
                Customer {getSortIcon("name")}
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="px-1 -ml-1"
                onClick={() => onSort("totalOrders")}
              >
                Orders {getSortIcon("totalOrders")}
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="px-1 -ml-1"
                onClick={() => onSort("totalSpent")}
              >
                Total Spent {getSortIcon("totalSpent")}
              </Button>
            </TableHead>
            <TableHead>
              <Button
                variant="ghost"
                className="px-1 -ml-1"
                onClick={() => onSort("lastOrderAt")}
              >
                Last Order {getSortIcon("lastOrderAt")}
              </Button>
            </TableHead>
            <TableHead className="w-[80px] text-right pr-4">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.length === 0 ? (
            <EmptyState localSearch={localSearch} showTrashed={showTrashed} />
          ) : (
            customers.map((customer) => (
              <CustomerRow
                key={customer.id}
                customer={customer}
                isSelected={selectedCustomers.has(customer.id)}
                showTrashed={showTrashed}
                isProcessing={isProcessing}
                symbol={symbol}
                onToggleSelection={onToggleSelection}
                onRestore={onRestore}
                onSetDialog={onSetDialog}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
