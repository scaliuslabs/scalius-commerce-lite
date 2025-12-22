// src/components/admin/RecentOrders.tsx
import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip"; // Import Tooltip components
import {
  ArrowRight,
  ArrowUpRight, // Using a slightly different icon for links
  Clock,
  Truck,
  CheckCircle,
  XCircle,
  Loader2, // For Processing
  Package, // For Empty State
} from "lucide-react";
import { formatDistanceToNow } from "date-fns"; // For relative dates

// Refined Order Interface (assuming createdAt is a Date object or string that can be parsed)
interface Order {
  id: string;
  customerName: string;
  totalAmount: number;
  status: string;
  createdAt: string | Date; // Allow string for potential API response
}

interface RecentOrdersProps {
  orders: Order[];
}

// Enhanced Status Styling with Icons
function getStatusInfo(status: string): {
  bg: string;
  text: string;
  border: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
} {
  switch (status.toLowerCase()) {
    case "pending":
      return {
        bg: "bg-amber-50 dark:bg-amber-900/30",
        text: "text-amber-700 dark:text-amber-300",
        border: "border-amber-200 dark:border-amber-700/50",
        icon: Clock,
        iconColor: "text-amber-500 dark:text-amber-400",
      };
    case "processing":
      return {
        bg: "bg-blue-50 dark:bg-blue-900/30",
        text: "text-blue-700 dark:text-blue-300",
        border: "border-blue-200 dark:border-blue-700/50",
        icon: Loader2, // Using Loader2 for processing
        iconColor: "text-blue-500 dark:text-blue-400 animate-spin", // Added spin animation
      };
    case "shipped":
      return {
        bg: "bg-violet-50 dark:bg-violet-900/30",
        text: "text-violet-700 dark:text-violet-300",
        border: "border-violet-200 dark:border-violet-700/50",
        icon: Truck,
        iconColor: "text-violet-500 dark:text-violet-400",
      };
    case "delivered":
      return {
        bg: "bg-emerald-50 dark:bg-emerald-900/30",
        text: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-200 dark:border-emerald-700/50",
        icon: CheckCircle,
        iconColor: "text-emerald-500 dark:text-emerald-400",
      };
    case "cancelled":
      return {
        bg: "bg-rose-50 dark:bg-rose-900/30",
        text: "text-rose-700 dark:text-rose-300",
        border: "border-rose-200 dark:border-rose-700/50",
        icon: XCircle,
        iconColor: "text-rose-500 dark:text-rose-400",
      };
    default:
      return {
        bg: "bg-gray-100 dark:bg-gray-800/50",
        text: "text-gray-700 dark:text-gray-300",
        border: "border-gray-200 dark:border-gray-700/50",
        icon: Clock, // Default to clock or another neutral icon
        iconColor: "text-gray-500 dark:text-gray-400",
      };
  }
}

// Helper to safely parse date
const parseOrderDate = (date: string | Date): Date | null => {
  try {
    return typeof date === "string" ? new Date(date) : date;
  } catch (e) {
    console.error("Failed to parse date:", date, e);
    return null;
  }
};

export function RecentOrders({ orders }: RecentOrdersProps) {
  return (
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
            <a href="/admin/orders">
              View All
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
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
                        <a href="/admin/products">
                          Manage Products
                          <ArrowRight className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                /* --- Enhanced Order Row --- */
                orders.map((order) => {
                  const statusInfo = getStatusInfo(order.status);
                  const IconComponent = statusInfo.icon;
                  const parsedDate = parseOrderDate(order.createdAt);

                  return (
                    <TableRow
                      key={order.id}
                      className="group border-gray-100 dark:border-gray-800/60 transition-colors hover:bg-gray-50/80 dark:hover:bg-gray-800/40"
                    >
                      {/* Order ID Cell */}
                      <TableCell className="py-3.5 px-6 font-medium">
                        <a
                          href={`/admin/orders/${order.id}/`}
                          className="group/link inline-flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-200 hover:text-primary dark:hover:text-primary-foreground/80 transition-colors"
                        >
                          <span className="font-mono text-[13px]">
                            #{order.id.substring(0, 8)}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500 opacity-0 transition-all duration-200 group-hover/link:opacity-100 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5" />
                        </a>
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
                          ৳{order.totalAmount.toLocaleString("en-US")}
                        </span>
                      </TableCell>

                      {/* Status Cell */}
                      <TableCell className="py-3.5 px-4">
                        <Badge
                          variant="outline"
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${statusInfo.bg} ${statusInfo.text} ${statusInfo.border} shadow-xs`}
                        >
                          <IconComponent
                            className={`h-3 w-3 ${statusInfo.iconColor}`}
                          />
                          {order.status}
                        </Badge>
                      </TableCell>

                      {/* Date Cell with Relative Time & Tooltip */}
                      <TableCell className="py-3.5 px-6 text-right">
                        {parsedDate ? (
                          <TooltipProvider delayDuration={150}>
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
                                  {parsedDate.toLocaleString("en-US", {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-sm text-gray-400 dark:text-gray-600">
                            Invalid Date
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}