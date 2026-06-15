import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
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
import type { Customer } from "~/types/api-responses";

function formatLocation(customer: Customer): string {
  const parts = [
    customer.address,
    customer.areaName,
    customer.zoneName,
    customer.cityName,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "";
}

interface CustomerColumnOptions {
  showTrashed: boolean;
  symbol: string;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onPermanentDelete: (id: string) => void;
}

export function getCustomerColumns(
  opts: CustomerColumnOptions,
): ColumnDef<Customer, unknown>[] {
  return [
    createSelectColumn<Customer>({ getLabel: (r) => (r as Customer).name }),
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Customer" />
      ),
      cell: ({ row }) => {
        const customer = row.original;
        const location = formatLocation(customer);
        return (
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
        <DataTableColumnHeader column={column} title="Total Spent" />
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
          <span suppressHydrationWarning>
            {formatDate(row.original.lastOrderAt)}
          </span>
        </div>
      ),
    },
    createActionsColumn<Customer>({
      showTrashed: opts.showTrashed,
      onEdit: (c) => opts.onEdit(c.id),
      onDelete: (c) => opts.onDelete(c.id),
      onRestore: (c) => opts.onRestore(c.id),
      onPermanentDelete: (c) => opts.onPermanentDelete(c.id),
    }),
  ];
}
