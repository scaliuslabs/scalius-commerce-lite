// src/components/admin/RecentOrders.tsx
import React, { memo } from "react";
import { formatDate } from "@scalius/shared/timestamps";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  ArrowRight,
  ArrowUpRight,
  Package,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useCurrency } from "@/hooks/use-currency";
import { OrderStatusBadge } from "./shared/StatusBadges";
import { Link } from "@tanstack/react-router";

interface Order {
  id: string;
  customerName: string;
  totalAmount: number;
  status: string;
  createdAt: string | number | Date;
}

interface RecentOrdersProps {
  orders: Order[];
}

// Helper to safely parse date
const parseOrderDate = (date: string | number | Date | null | undefined): Date | null => {
  if (!date) return null;
  try {
    const d =
      typeof date === "number"
        ? new Date(date < 10_000_000_000 ? date * 1000 : date)
        : typeof date === "string"
          ? new Date(date)
          : date;
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  } catch {
    return null;
  }
};

export const RecentOrders = memo(function RecentOrders({ orders }: RecentOrdersProps) {
  const { symbol } = useCurrency();
  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading recent orders. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <Card className="border-0 shadow-none bg-transparent">
      {/* --- Enhanced Card Header --- */}
      <CardHeader className="px-6 pt-5 pb-4 border-b border-gray-100 dark:border-gray-800/50 bg-white dark:bg-gray-900/50 rounded-t-2xl">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle className="text-base font-semibold leading-none tracking-tight text-gray-900 dark:text-gray-50">
              Recent Orders
            </CardTitle>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Latest transactions from your store.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            asChild
            className="h-8 gap-1 border-gray-200 dark:border-gray-700/80 bg-white dark:bg-gray-900/80 hover:bg-gray-50 dark:hover:bg-gray-800/60 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 px-3 text-xs font-medium shadow-xs hover:shadow-sm transition-all hover:-translate-y-px active:translate-y-0"
          >
            <Link to="/admin/orders">
              View All
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>

      {/* --- Table Content --- */}
      <CardContent className="p-0 bg-white dark:bg-gray-900/50 rounded-b-2xl overflow-hidden">
        {/* Add overflow-x-auto for potential responsiveness */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {/* Refined Table Header Row */}
              <TableRow className="border-gray-100 dark:border-gray-800/60 hover:bg-transparent">
                <TableHead className="w-[120px] py-3 px-6 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Order ID
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Customer
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">
                  Amount
                </TableHead>
                <TableHead className="py-3 px-4 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Status
                </TableHead>
                <TableHead className="py-3 px-6 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 text-right">
                  Date
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* --- Enhanced Empty State --- */}
              {orders.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="h-48 text-center border-0"
                  >
                    <div className="flex flex-col items-center justify-center gap-3 text-center">
                      <div className="p-3 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700/80 shadow-md dark:shadow-lg">
                        <Package className="h-7 w-7 text-gray-500 dark:text-gray-400" />
                      </div>
                      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200">
                        No Recent Orders Found
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
                        When new orders are placed, they will appear here.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        className="mt-2 h-8 gap-1 border-gray-200 dark:border-gray-700/80 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/60 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 px-3 text-xs font-medium shadow-xs hover:shadow-sm transition-all hover:-translate-y-px active:translate-y-0"
                      >
                        <Link to="/admin/products">
                          Manage Products
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                /* --- Enhanced Order Row --- */
                <TooltipProvider delayDuration={150}>
                {orders.map((order) => {
                  const parsedDate = parseOrderDate(order.createdAt);

                  return (
                    <TableRow
                      key={order.id}
                      className="group border-gray-100 dark:border-gray-800/60 transition-colors hover:bg-gray-50/80 dark:hover:bg-gray-800/40"
                    >
                      {/* Order ID Cell */}
                      <TableCell className="py-3.5 px-6 font-medium">
                        <Link
                          to={`/admin/orders/${order.id}` as string}
                          className="group/link inline-flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 hover:text-primary dark:hover:text-primary-foreground/80 transition-colors"
                        >
                          <span className="font-mono text-[13px]">
                            #{order.id.substring(0, 8)}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 opacity-0 transition-all duration-200 group-hover/link:opacity-100 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5" />
                        </Link>
                      </TableCell>

                      {/* Customer Cell */}
                      <TableCell className="py-3.5 px-4">
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                          {order.customerName}
                        </span>
                      </TableCell>

                      {/* Amount Cell */}
                      <TableCell className="py-3.5 px-4 text-right">
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {symbol}{order.totalAmount.toLocaleString("en-US")}
                        </span>
                      </TableCell>

                      {/* Status Cell */}
                      <TableCell className="py-3.5 px-4">
                        <OrderStatusBadge status={order.status} />
                      </TableCell>

                      {/* Date Cell with Relative Time & Tooltip */}
                      <TableCell className="py-3.5 px-6 text-right">
                        {parsedDate ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-sm text-gray-600 dark:text-gray-400 cursor-default">
                                  {formatDistanceToNow(parsedDate, {
                                    addSuffix: true,
                                  })}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top" align="end">
                                <p className="text-xs">
                                  {formatDate(parsedDate)}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                        ) : (
                          <span className="text-sm text-gray-400 dark:text-gray-600">
                            Invalid Date
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                </TooltipProvider>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
    </ErrorBoundary>
  );
});
