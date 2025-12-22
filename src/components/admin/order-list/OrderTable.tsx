import type { OrderListItem } from "@/lib/admin";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ShoppingBag, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import { OrderTableRow } from "./OrderTableRow";
import { OrderMobileCard } from "./OrderMobileCard";
import { useState } from "react";

type SortField =
  | "customerName"
  | "totalAmount"
  | "status"
  | "createdAt"
  | "updatedAt";
type SortOrder = "asc" | "desc";

interface OrderTableProps {
  orders: OrderListItem[];
  shipmentStatuses: Record<string, any>;
  selectedOrders: Set<string>;
  updatingStatusIds: Set<string>;
  sort: {
    field: SortField;
    order: SortOrder;
  };
  showTrashed: boolean;
  searchQuery: string;
  onSort: (field: SortField) => void;
  onToggleAll: () => void;
  onToggleSelection: (id: string, shiftKey?: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onPermanentDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onStatusUpdate: (orderId: string, newStatus: string) => void;
  onShipmentStatusUpdated: (updatedShipment: any) => void;
  onRefreshAllShipments?: () => void;
}

export function OrderTable({
  orders,
  shipmentStatuses,
  selectedOrders,
  updatingStatusIds,
  sort,
  showTrashed,
  searchQuery,
  onSort,
  onToggleAll,
  onToggleSelection,
  onEdit,
  onDelete,
  onPermanentDelete,
  onRestore,
  onStatusUpdate,
  onShipmentStatusUpdated,
  onRefreshAllShipments,
}: OrderTableProps) {
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);

  const handleRefreshAll = () => {
    if (onRefreshAllShipments) {
      setIsRefreshingAll(true);
      Promise.resolve(onRefreshAllShipments()).finally(() => {
        setIsRefreshingAll(false);
      });
    }
  };
  const getSortIcon = (field: SortField) => {
    if (sort.field !== field)
      return <ArrowUpDown className="ml-2 h-4 w-4 text-gray-400" />;
    return sort.order === "asc" ? (
      <ArrowUp className="ml-2 h-4 w-4 text-primary" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4 text-primary" />
    );
  };

  return (
    <>
      {/* Desktop Table View */}
      <div className="hidden md:block overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-inner backdrop-blur-lg">
        <Table>
        <TableHeader className="border-b-2 border-[var(--border)]">
          <TableRow className="border-b-0 bg-[var(--muted)]/10 hover:bg-[var(--muted)]/20">
            <TableHead className="w-[40px] py-4 pl-4">
              <Checkbox
                checked={
                  selectedOrders.size === orders.length && orders.length > 0
                }
                onCheckedChange={onToggleAll}
                className="translate-y-[2px] transition-all duration-200"
                aria-label="Select all orders"
              />
            </TableHead>
            <TableHead
              className={`py-4 hover:cursor-pointer ${
                sort.field === "customerName"
                  ? "text-primary"
                  : "text-[var(--foreground)]"
              }`}
              onClick={() => onSort("customerName")}
            >
              <div className="flex items-center">
                Customer {getSortIcon("customerName")}
              </div>
            </TableHead>
            <TableHead className="py-4 text-[var(--foreground)]">
              Items
            </TableHead>
            <TableHead
              className={`py-4 hover:cursor-pointer ${
                sort.field === "totalAmount" ? "text-primary" : ""
              }`}
              onClick={() => onSort("totalAmount")}
            >
              <div className="flex items-center">
                Amount {getSortIcon("totalAmount")}
              </div>
            </TableHead>
            <TableHead
              className={`py-4 hover:cursor-pointer ${
                sort.field === "status" ? "text-primary" : ""
              }`}
              onClick={() => onSort("status")}
            >
              <div className="flex items-center">
                Status {getSortIcon("status")}
              </div>
            </TableHead>
            <TableHead className="py-4">
              <div className="flex items-center gap-2">
                Shipment
                {onRefreshAllShipments && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshAll}
                    disabled={isRefreshingAll}
                    className="h-6 w-6 p-0"
                    title="Refresh all shipments"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${isRefreshingAll ? "animate-spin" : ""}`}
                    />
                  </Button>
                )}
              </div>
            </TableHead>
            <TableHead
              className={`py-4 hover:cursor-pointer ${
                sort.field === "createdAt" ? "text-primary" : ""
              }`}
              onClick={() => onSort("createdAt")}
            >
              <div className="flex items-center">
                Date {getSortIcon("createdAt")}
              </div>
            </TableHead>
            <TableHead className="w-[100px] py-4 pr-4 text-right">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <div className="flex flex-col items-center justify-center gap-3 py-12 animate-in fade-in duration-500">
                  <div className="rounded-full bg-gradient-to-b from-[var(--muted)] to-[var(--card)] p-3 shadow-sm ring-1 ring-[var(--border)]/80 transition-all duration-300 hover:shadow-md hover:ring-[var(--border)]/60 hover:scale-105">
                    <div className="rounded-full bg-[var(--card)] p-2 shadow-sm">
                      <ShoppingBag className="h-5 w-5 text-[var(--muted-foreground)] animate-pulse" />
                    </div>
                  </div>
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    {showTrashed ? "No orders in trash" : "No orders found"}
                  </p>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    {showTrashed
                      ? "Deleted orders will appear here"
                      : searchQuery
                        ? "Try adjusting your search"
                        : "New orders will appear here"}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            orders.map((order) => (
              <OrderTableRow
                key={order.id}
                order={order}
                shipment={shipmentStatuses[order.id]}
                isSelected={selectedOrders.has(order.id)}
                isUpdatingStatus={updatingStatusIds.has(order.id)}
                showTrashed={showTrashed}
                onToggleSelection={onToggleSelection}
                onEdit={onEdit}
                onDelete={onDelete}
                onPermanentDelete={onPermanentDelete}
                onRestore={onRestore}
                onStatusUpdate={onStatusUpdate}
                onShipmentStatusUpdated={onShipmentStatusUpdated}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>

      {/* Mobile Card View */}
      <div className="md:hidden px-4">
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <div className="rounded-full bg-gradient-to-b from-[var(--muted)] to-[var(--card)] p-3 shadow-sm ring-1 ring-[var(--border)]/80">
              <div className="rounded-full bg-[var(--card)] p-2 shadow-sm">
                <ShoppingBag className="h-5 w-5 text-[var(--muted-foreground)]" />
              </div>
            </div>
            <p className="text-sm font-medium text-[var(--foreground)]">
              {showTrashed ? "No orders in trash" : "No orders found"}
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">
              {showTrashed
                ? "Deleted orders will appear here"
                : searchQuery
                  ? "Try adjusting your search"
                  : "New orders will appear here"}
            </p>
          </div>
        ) : (
          <>
            {orders.map((order) => (
              <OrderMobileCard
                key={order.id}
                order={order}
                shipment={shipmentStatuses[order.id]}
                isSelected={selectedOrders.has(order.id)}
                isUpdatingStatus={updatingStatusIds.has(order.id)}
                showTrashed={showTrashed}
                onToggleSelection={onToggleSelection}
                onEdit={onEdit}
                onDelete={onDelete}
                onPermanentDelete={onPermanentDelete}
                onRestore={onRestore}
                onStatusUpdate={onStatusUpdate}
                onShipmentStatusUpdated={onShipmentStatusUpdated}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}
