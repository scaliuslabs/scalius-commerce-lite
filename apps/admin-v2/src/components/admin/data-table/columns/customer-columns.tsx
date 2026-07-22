import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import {
  Clock,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  ShoppingBag,
} from "lucide-react";
import { DataTableColumnHeader } from "../DataTableColumnHeader";
import { createSelectColumn, createActionsColumn } from "./column-factories";
import { CustomerAccountBadge } from "~/components/admin/customer-list/CustomerAccountBadge";
import { CustomerOrderRetentionBadge } from "~/components/admin/customer-list/CustomerOrderRetentionBadge";
import { formatAdminDate } from "~/lib/admin-time";
import {
  customerHasAccount,
  formatCustomerLocation,
  type CustomerListBuyer,
} from "~/components/admin/customer-list/customer-list-model";

interface CustomerColumnOptions {
  showTrashed: boolean;
  symbol: string;
  canSelect: boolean;
  canViewHistory: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

export function getCustomerColumns(
  opts: CustomerColumnOptions,
): ColumnDef<CustomerListBuyer, unknown>[] {
  return [
    ...(opts.canSelect
      ? [createSelectColumn<CustomerListBuyer>({
          getLabel: (row) => (row as CustomerListBuyer).name,
        })]
      : []),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Customer" />
      ),
      cell: ({ row }) => {
        const customer = row.original;
        const location = formatCustomerLocation(customer);
        const buyerName = customer.name || "Unnamed buyer";
        return (
          <div className="flex flex-col">
            <div className="flex w-fit max-w-full items-center gap-1.5">
              {opts.canViewHistory ? (
                <Link
                  to="/admin/customers/$customerId/history"
                  params={{ customerId: customer.id }}
                  className="flex min-w-0 items-center gap-1 text-primary hover:underline"
                >
                  <span className="truncate">{buyerName}</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
                </Link>
              ) : (
                <span className="truncate font-medium text-foreground">{buyerName}</span>
              )}
              <CustomerAccountBadge hasAccount={customerHasAccount(customer)} />
              {opts.showTrashed && customer.totalOrders > 0 ? (
                <CustomerOrderRetentionBadge />
              ) : null}
            </div>
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
        );
      },
      size: 250,
    },
    {
      accessorKey: "totalOrders",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Orders" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-2 text-sm">
          <ShoppingBag className="h-4 w-4 text-muted-foreground" />
          {row.original.totalOrders}
        </div>
      ),
    },
    {
      accessorKey: "totalSpent",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Paid Spend" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{opts.symbol}</span>
          {row.original.totalSpent.toLocaleString()}
        </div>
      ),
    },
    {
      accessorKey: "lastOrderAt",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Last Order" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>
            {formatAdminDate(row.original.lastOrderAt) ?? "No orders"}
          </span>
        </div>
      ),
    },
    ...((!opts.showTrashed && opts.canEdit) || opts.canDelete
      ? [createActionsColumn<CustomerListBuyer>({
          showTrashed: opts.showTrashed,
          onEdit: !opts.showTrashed && opts.canEdit
            ? (customer) => opts.onEdit(customer.id)
            : undefined,
          onDelete: !opts.showTrashed && opts.canDelete
            ? (customer) => opts.onDelete(customer.id)
            : undefined,
          onRestore: opts.showTrashed && opts.canDelete
            ? (customer) => opts.onRestore(customer.id)
            : undefined,
          onPermanentDelete: opts.showTrashed && opts.canDelete
            ? (customer) => opts.onPermanentDelete(customer.id)
            : undefined,
          canPermanentDelete: (customer) => customer.totalOrders === 0,
        })]
      : []),
  ];
}
