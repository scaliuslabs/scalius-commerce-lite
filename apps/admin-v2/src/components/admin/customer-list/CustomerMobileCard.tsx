import { Link } from "@tanstack/react-router";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import { formatDateShort } from "@scalius/shared/timestamps";
import { Mail, MapPin, Phone } from "lucide-react";

import { DataTableRowActions } from "~/components/admin/data-table/DataTableRowActions";
import { Checkbox } from "~/components/ui/checkbox";
import { CustomerAccountBadge } from "./CustomerAccountBadge";
import {
  customerHasAccount,
  formatCustomerLocation,
  type CustomerListBuyer,
} from "./customer-list-model";

interface CustomerMobileCardProps {
  customer: CustomerListBuyer;
  selected: boolean;
  showTrashed: boolean;
  symbol: string;
  canSelect: boolean;
  canViewHistory: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
}

export function CustomerMobileCard({
  customer,
  selected,
  showTrashed,
  symbol,
  canSelect,
  canViewHistory,
  canEdit,
  canDelete,
  onSelectedChange,
  onEdit,
  onArchive,
  onRestore,
  onPermanentDelete,
}: CustomerMobileCardProps) {
  const location = formatCustomerLocation(customer);
  const buyerName = customer.name || "Unnamed buyer";
  const hasActions = showTrashed ? canDelete : canEdit || canDelete;
  const name = canViewHistory ? (
    <Link
      to="/admin/customers/$customerId/history"
      params={{ customerId: customer.id }}
      className="min-w-0 truncate text-sm font-semibold text-foreground hover:underline"
    >
      {buyerName}
    </Link>
  ) : (
    <span className="min-w-0 truncate text-sm font-semibold text-foreground">
      {buyerName}
    </span>
  );

  return (
    <article className={selected ? "bg-primary/5 px-3 py-3" : "bg-background px-3 py-3"}>
      <div className={`grid items-start gap-2.5 ${canSelect ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
        {canSelect ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(value) => onSelectedChange(value === true)}
            aria-label={`Select ${buyerName}`}
            className="mt-0.5"
          />
        ) : null}

        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            {name}
            <CustomerAccountBadge hasAccount={customerHasAccount(customer)} />
          </div>
          <div className="mt-1.5 space-y-1 text-[11px] leading-4 text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{formatPhoneForDisplay(customer.phone)}</span>
            </div>
            {customer.email ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{customer.email}</span>
              </div>
            ) : null}
            {location ? (
              <div className="flex min-w-0 items-start gap-1.5">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="line-clamp-2">{location}</span>
              </div>
            ) : null}
          </div>
        </div>

        {hasActions ? (
          <DataTableRowActions
            showTrashed={showTrashed}
            menuLabel={`Open actions for ${buyerName}`}
            onEdit={!showTrashed && canEdit ? onEdit : undefined}
            onDelete={!showTrashed && canDelete ? onArchive : undefined}
            onRestore={showTrashed && canDelete ? onRestore : undefined}
            onPermanentDelete={showTrashed && canDelete ? onPermanentDelete : undefined}
          />
        ) : null}
      </div>

      <dl className="mt-3 grid grid-cols-3 divide-x rounded-md border bg-muted/20 py-2 text-center">
        <div className="min-w-0 px-2">
          <dt className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Orders</dt>
          <dd className="mt-0.5 text-xs font-semibold tabular-nums text-foreground">{customer.totalOrders}</dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Paid spend</dt>
          <dd className="mt-0.5 truncate text-xs font-semibold tabular-nums text-foreground">
            {symbol}{customer.totalSpent.toLocaleString()}
          </dd>
        </div>
        <div className="min-w-0 px-2">
          <dt className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Last order</dt>
          <dd className="mt-0.5 truncate text-[11px] font-medium text-foreground" suppressHydrationWarning>
            {customer.lastOrderAt ? formatDateShort(customer.lastOrderAt) : "No orders"}
          </dd>
        </div>
      </dl>

      {canViewHistory ? (
        <Link
          to="/admin/customers/$customerId/history"
          params={{ customerId: customer.id }}
          className="mt-2.5 inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View order history
        </Link>
      ) : null}
    </article>
  );
}
