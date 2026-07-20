//src/components/admin/QuickActions.tsx
import { Link } from "@tanstack/react-router";
import { ErrorBoundary } from "./ErrorBoundary";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import {
  Plus,
  Package,
  Tags,
  Truck,
  Settings,
  FileText,
  Image,
  Users,
} from "lucide-react";

const actions = [
  {
    title: "Add product",
    href: "/admin/products/new",
    icon: Plus,
  },
  {
    title: "Products",
    href: "/admin/products",
    icon: Package,
  },
  {
    title: "Categories",
    href: "/admin/categories",
    icon: Tags,
  },
  {
    title: "Orders",
    href: "/admin/orders",
    icon: FileText,
  },
  {
    title: "Customers",
    href: "/admin/customers",
    icon: Users,
  },
  {
    title: "Media",
    href: "/admin/media",
    icon: Image,
  },
  {
    title: "Delivery",
    href: "/admin/settings/delivery-providers",
    icon: Truck,
  },
  {
    title: "Settings",
    href: "/admin/settings",
    icon: Settings,
  },
] as const;

export function QuickActions() {
  return (
    <ErrorBoundary
      fallback={
        <div className="p-4 text-center text-muted-foreground">
          Something went wrong loading quick actions.{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="underline"
          >
            Reload
          </button>
        </div>
      }
    >
      <Card className="border-0 shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold leading-none tracking-tight">
            Quick Actions
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 p-0 lg:grid-cols-1">
          {actions.map((action) => (
            <Button
              key={action.href}
              variant="outline"
              className="h-11 w-full justify-start gap-2.5 px-3 shadow-none"
              asChild
            >
              <Link to={action.href}>
                <action.icon className="size-4 text-muted-foreground" />
                <span className="truncate text-sm font-medium">
                  {action.title}
                </span>
              </Link>
            </Button>
          ))}
        </CardContent>
      </Card>
    </ErrorBoundary>
  );
}
