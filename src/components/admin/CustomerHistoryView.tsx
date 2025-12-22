// src/components/admin/CustomerHistoryView.tsx
import React, { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Phone,
  Mail,
  MapPin,
  ShoppingBag,
  DollarSign,
  Clock,
  ArrowLeft,
  History,
  Edit,
  User,
  MapPinned,
  Building,
  Home,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Truck,
  Package,
  XCircle,
  Loader2,
  Archive,
  ClipboardList,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "../ui/separator";
import { ScrollArea } from "../ui/scroll-area";
import { Avatar, AvatarFallback } from "../ui/avatar";

// --- Interfaces (Unchanged) ---
interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
}

interface CustomerHistory {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  address: string | null;
  city: string | null;
  zone: string | null;
  area: string | null;
  changeType: "created" | "updated" | "deleted";
  createdAt: Date;
  cityName?: string;
  zoneName?: string;
  areaName?: string | null;
}

interface Order {
  id: string;
  totalAmount: number;
  status: string;
  createdAt: Date;
}

interface CustomerHistoryViewProps {
  customer: Customer;
  history: CustomerHistory[];
  orders: Order[];
}
// --- End Interfaces ---

// --- Helper Functions (Mostly Unchanged) ---
const formatDate = (
  date: Date | number | string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string => {
  if (date === null || date === undefined) return "N/A";

  let dateObj: Date;
  try {
    if (typeof date === "number" || typeof date === "string") {
      // Assume seconds if it's a typical Unix timestamp length, otherwise milliseconds
      const numDate = typeof date === "string" ? parseInt(date, 10) : date;
      if (isNaN(numDate)) throw new Error("Invalid date string/number");
      dateObj = new Date(numDate * (numDate < 10000000000 ? 1000 : 1));
    } else if (date instanceof Date) {
      dateObj = date;
    } else {
      throw new Error("Invalid date type");
    }

    if (isNaN(dateObj.getTime())) {
      throw new Error("Invalid date value");
    }

    // Correct potential timestamp issues (simple check)
    if (
      dateObj.getFullYear() > 3000 &&
      typeof date !== "string" &&
      typeof date !== "number"
    ) {
      // If original wasn't a number/string timestamp, it's likely just an invalid date
      throw new Error("Year seems too large, likely invalid date");
    } else if (dateObj.getFullYear() > 3000) {
      // Try assuming milliseconds if it was a large number
      const correctedDate = new Date(dateObj.getTime() / 1000);
      if (
        !isNaN(correctedDate.getTime()) &&
        correctedDate.getFullYear() < 3000
      ) {
        dateObj = correctedDate;
      } else {
        throw new Error("Year seems too large, timestamp correction failed");
      }
    }

    const defaultOptions: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      // timeZoneName: "short", // Consider removing timezone for brevity unless crucial
    };

    const mergedOptions = { ...defaultOptions, ...options };

    return dateObj.toLocaleString("en-US", mergedOptions);
  } catch (error) {
    console.error("Error formatting date:", date, error);
    return "Invalid date";
  }
};

const getInitials = (name: string) => {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean) // Ensure empty parts don't cause issues
    .join("")
    .toUpperCase()
    .substring(0, 2);
};

const getStatusBadgeVariant = (status: string): string => {
  switch (status?.toLowerCase()) {
    case "pending":
      return "bg-yellow-100 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300 dark:border-yellow-700/50";
    case "processing":
      return "bg-blue-100 text-blue-800 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/50";
    case "shipped":
      return "bg-purple-100 text-purple-800 border border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700/50";
    case "delivered":
      return "bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700/50";
    case "cancelled":
      return "bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/50";
    default:
      return "bg-gray-100 text-gray-800 border border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600";
  }
};

const getStatusIcon = (status: string) => {
  const iconClass = "h-3.5 w-3.5";
  switch (status?.toLowerCase()) {
    case "pending":
      return <AlertCircle className={iconClass} />;
    case "processing":
      return <Package className={iconClass} />;
    case "shipped":
      return <Truck className={iconClass} />;
    case "delivered":
      return <CheckCircle2 className={iconClass} />;
    case "cancelled":
      return <XCircle className={iconClass} />;
    default:
      return <Package className={iconClass} />;
  }
};

const getChangeTypeBadgeVariant = (
  type: CustomerHistory["changeType"],
): string => {
  switch (type) {
    case "created":
      return "bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700/50";
    case "updated":
      return "bg-blue-100 text-blue-800 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/50";
    case "deleted":
      return "bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/50";
    default:
      return "bg-gray-100 text-gray-800 border border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600";
  }
};

// --- Main Component ---
export function CustomerHistoryView({
  customer,
  history,
  orders,
}: CustomerHistoryViewProps) {
  const ITEMS_PER_PAGE = 5; // Define items per page
  const [displayedOrdersCount, setDisplayedOrdersCount] =
    useState(ITEMS_PER_PAGE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const loadMoreOrders = useCallback(() => {
    setIsLoadingMore(true);
    // Simulate loading delay if needed, or remove for instant load
    setTimeout(() => {
      setDisplayedOrdersCount((prevCount) => prevCount + ITEMS_PER_PAGE);
      setIsLoadingMore(false);
    }, 300); // Keep small delay for visual feedback
  }, []);

  const displayedOrders = React.useMemo(() => {
    return orders.slice(0, displayedOrdersCount);
  }, [orders, displayedOrdersCount]);

  const hasMoreOrders = displayedOrdersCount < orders.length;

  const addressLines = [
    customer.address,
    customer.areaName || customer.area,
    customer.zoneName || customer.zone,
    customer.cityName || customer.city,
  ].filter(Boolean); // Filter out null/empty values

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {" "}
      {/* Consistent padding */}
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16 text-lg border">
            {" "}
            {/* Use Avatar Component */}
            {/* <AvatarImage src={customer.avatarUrl} alt={customer.name} /> // Add if you have avatar URLs */}
            <AvatarFallback>{getInitials(customer.name)}</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
              {customer.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Customer since{" "}
              {formatDate(customer.createdAt, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" asChild size="sm">
            <a href="/admin/customers">
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Back
            </a>
          </Button>
          <Button asChild size="sm">
            <a href={`/admin/customers/${customer.id}/edit`}>
              <Edit className="mr-1.5 h-4 w-4" />
              Edit
            </a>
          </Button>
        </div>
      </div>
      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Customer Profile Card */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <User className="h-5 w-5" />
              Customer Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            {" "}
            {/* Reduced top padding */}
            {/* Contact Info */}
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">
                <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                <a
                  href={`tel:${customer.phone}`}
                  className="font-medium hover:text-primary transition-colors break-all"
                >
                  {customer.phone}
                </a>
              </div>
              {customer.email && (
                <div className="flex items-center gap-3">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <a
                    href={`mailto:${customer.email}`}
                    className="hover:text-primary transition-colors break-all"
                  >
                    {customer.email}
                  </a>
                </div>
              )}
            </div>
            {/* Address Info */}
            {addressLines.length > 0 && (
              <>
                <Separator />
                <div className="flex items-start gap-3 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    {customer.address && <p>{customer.address}</p>}
                    {(customer.areaName || customer.area) && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Home className="h-3 w-3" />
                        <span>{customer.areaName || customer.area}</span>
                      </div>
                    )}
                    {(customer.zoneName || customer.zone) && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <MapPinned className="h-3 w-3" />
                        <span>{customer.zoneName || customer.zone}</span>
                      </div>
                    )}
                    {(customer.cityName || customer.city) && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Building className="h-3 w-3" />
                        <span>{customer.cityName || customer.city}</span>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
            {/* Stats */}
            <Separator />
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-1 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShoppingBag className="h-3.5 w-3.5" />
                  <span>Total Orders</span>
                </div>
                <p className="text-xl font-semibold">{customer.totalOrders}</p>
              </div>
              <div className="space-y-1 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <DollarSign className="h-3.5 w-3.5" />
                  <span>Total Spent</span>
                </div>
                <p className="text-xl font-semibold">
                  ৳
                  {customer.totalSpent.toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}{" "}
                  {/* Format currency */}
                </p>
              </div>
            </div>
            {/* Last Order */}
            {customer.lastOrderAt && (
              <>
                <Separator />
                <div className="flex items-center gap-3 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <span className="text-xs text-muted-foreground">
                      Last order placed
                    </span>
                    <p className="font-medium">
                      {formatDate(customer.lastOrderAt, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Recent Orders Card */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <ClipboardList className="h-5 w-5" />
                Recent Orders
              </CardTitle>
              <Badge variant="outline">{orders.length} total</Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="border rounded-md overflow-hidden">
              {" "}
              {/* Add border around table */}
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    {" "}
                    {/* Subtle header background */}
                    <TableHead className="w-[120px]">Order ID</TableHead>
                    <TableHead className="w-[150px]">Date</TableHead>
                    <TableHead className="w-[120px]">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedOrders.length > 0 ? (
                    displayedOrders.map((order) => (
                      <TableRow key={order.id} className="hover:bg-muted/30">
                        <TableCell className="font-medium">
                          <Button
                            variant="link"
                            size="sm"
                            asChild
                            className="p-0 h-auto font-medium text-primary"
                          >
                            <a
                              href={`/admin/orders/${order.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              #{order.id.substring(0, 6)} {/* Shorten ID */}
                              <ExternalLink className="ml-1 h-3 w-3" />
                            </a>
                          </Button>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(order.createdAt, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </TableCell>
                        <TableCell className="font-medium">
                          ৳
                          {order.totalAmount.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary" // Use secondary as base, let cn override colors
                            className={cn(
                              "capitalize flex items-center gap-1.5 text-xs px-2 py-0.5 font-medium",
                              getStatusBadgeVariant(order.status),
                            )}
                          >
                            {getStatusIcon(order.status)}
                            {order.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="h-36 text-center">
                        <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                          <Archive className="h-10 w-10" />
                          <p className="font-medium">No Orders Yet</p>
                          <p className="text-xs">
                            This customer hasn't placed any orders.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {hasMoreOrders && (
              <div className="mt-4 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMoreOrders}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load More (${orders.length - displayedOrdersCount} remaining)`
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {/* Change History Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <History className="h-5 w-5" />
              Change History
            </CardTitle>
            <Badge variant="outline">{history.length} changes</Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {history.length > 0 ? (
            <ScrollArea className="h-[400px] w-full pr-4">
              {" "}
              {/* Ensure full width */}
              {/* Timeline Implementation */}
              <div className="relative pl-6 space-y-6">
                {/* Vertical line */}
                <div
                  className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-border"
                  aria-hidden="true"
                ></div>

                {history.map((record) => {
                  const recordAddressLines = [
                    record.address,
                    record.areaName || record.area,
                    record.zoneName || record.zone,
                    record.cityName || record.city,
                  ].filter(Boolean);

                  return (
                    <div
                      key={record.id}
                      className="relative flex items-start space-x-3"
                    >
                      {/* Dot */}
                      <div className="relative flex items-center justify-center mt-1.5">
                        <span
                          className="absolute -left-[19px] h-4 w-4 rounded-full border-2 border-background bg-primary ring-1 ring-border"
                          aria-hidden="true"
                        ></span>
                      </div>

                      {/* Content */}
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs">
                          <Badge
                            variant="secondary"
                            className={cn(
                              "capitalize px-1.5 py-0",
                              getChangeTypeBadgeVariant(record.changeType),
                            )}
                          >
                            {record.changeType}
                          </Badge>
                          <span className="text-muted-foreground whitespace-nowrap">
                            {formatDate(record.createdAt)}
                          </span>
                        </div>
                        <div className="rounded-md border bg-card p-3 text-sm hover:bg-muted/50 transition-colors">
                          <p className="font-medium">{record.name}</p>
                          <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                            {record.phone && (
                              <div className="flex items-center gap-1.5">
                                <Phone className="h-3 w-3 shrink-0" />
                                <span>{record.phone}</span>
                              </div>
                            )}
                            {record.email && (
                              <div className="flex items-center gap-1.5">
                                <Mail className="h-3 w-3 shrink-0" />
                                <span>{record.email}</span>
                              </div>
                            )}
                            {recordAddressLines.length > 0 && (
                              <div className="flex items-start gap-1.5 mt-1">
                                <MapPin className="h-3 w-3 mt-px shrink-0" />
                                <div className="space-y-0.5">
                                  {record.address && <p>{record.address}</p>}
                                  {(record.areaName || record.area) && (
                                    <p>{record.areaName || record.area}</p>
                                  )}
                                  {(record.zoneName || record.zone) && (
                                    <p>{record.zoneName || record.zone}</p>
                                  )}
                                  {(record.cityName || record.city) && (
                                    <p>{record.cityName || record.city}</p>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          ) : (
            <div className="h-48 flex flex-col items-center justify-center gap-2 text-muted-foreground border rounded-md">
              <Archive className="h-10 w-10" />
              <p className="font-medium">No Change History</p>
              <p className="text-xs">
                Changes to this customer will appear here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
