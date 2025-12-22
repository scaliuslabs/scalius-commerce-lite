//src/components/admin/QuickActions.tsx
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
  ArrowRight,
} from "lucide-react";

const actions = [
  {
    title: "New Product",
    href: "/admin/products/new",
    icon: Plus,
    description: "Add a new product to your store",
    color: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    border:
      "group-hover:border-emerald-200/60 dark:group-hover:border-emerald-800/60",
    iconBg:
      "bg-gradient-to-br from-emerald-400 to-emerald-600 dark:from-emerald-500 dark:to-emerald-700",
    glowBg:
      "group-hover:before:bg-emerald-500/5 dark:group-hover:before:bg-emerald-500/10",
    shadow: "shadow-emerald-500/25 dark:shadow-emerald-500/10",
  },
  {
    title: "Products",
    href: "/admin/products",
    icon: Package,
    description: "Manage your product catalog",
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-950/30",
    border:
      "group-hover:border-blue-200/60 dark:group-hover:border-blue-800/60",
    iconBg:
      "bg-gradient-to-br from-blue-400 to-blue-600 dark:from-blue-500 dark:to-blue-700",
    glowBg:
      "group-hover:before:bg-blue-500/5 dark:group-hover:before:bg-blue-500/10",
    shadow: "shadow-blue-500/25 dark:shadow-blue-500/10",
  },
  {
    title: "Categories",
    href: "/admin/categories",
    icon: Tags,
    description: "Organize your products",
    color: "text-violet-600 dark:text-violet-400",
    bg: "bg-violet-50 dark:bg-violet-950/30",
    border:
      "group-hover:border-violet-200/60 dark:group-hover:border-violet-800/60",
    iconBg:
      "bg-gradient-to-br from-violet-400 to-violet-600 dark:from-violet-500 dark:to-violet-700",
    glowBg:
      "group-hover:before:bg-violet-500/5 dark:group-hover:before:bg-violet-500/10",
    shadow: "shadow-violet-500/25 dark:shadow-violet-500/10",
  },
  {
    title: "Orders",
    href: "/admin/orders",
    icon: FileText,
    description: "View and manage orders",
    color: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    border:
      "group-hover:border-amber-200/60 dark:group-hover:border-amber-800/60",
    iconBg:
      "bg-gradient-to-br from-amber-400 to-amber-600 dark:from-amber-500 dark:to-amber-700",
    glowBg:
      "group-hover:before:bg-amber-500/5 dark:group-hover:before:bg-amber-500/10",
    shadow: "shadow-amber-500/25 dark:shadow-amber-500/10",
  },
  {
    title: "Customers",
    href: "/admin/customers",
    icon: Users,
    description: "Manage your customers",
    color: "text-pink-600 dark:text-pink-400",
    bg: "bg-pink-50 dark:bg-pink-950/30",
    border:
      "group-hover:border-pink-200/60 dark:group-hover:border-pink-800/60",
    iconBg:
      "bg-gradient-to-br from-pink-400 to-pink-600 dark:from-pink-500 dark:to-pink-700",
    glowBg:
      "group-hover:before:bg-pink-500/5 dark:group-hover:before:bg-pink-500/10",
    shadow: "shadow-pink-500/25 dark:shadow-pink-500/10",
  },
  {
    title: "Media",
    href: "/admin/media",
    icon: Image,
    description: "Manage your media files",
    color: "text-indigo-600 dark:text-indigo-400",
    bg: "bg-indigo-50 dark:bg-indigo-950/30",
    border:
      "group-hover:border-indigo-200/60 dark:group-hover:border-indigo-800/60",
    iconBg:
      "bg-gradient-to-br from-indigo-400 to-indigo-600 dark:from-indigo-500 dark:to-indigo-700",
    glowBg:
      "group-hover:before:bg-indigo-500/5 dark:group-hover:before:bg-indigo-500/10",
    shadow: "shadow-indigo-500/25 dark:shadow-indigo-500/10",
  },
  {
    title: "Shipping",
    href: "/admin/settings/shipping-methods",
    icon: Truck,
    description: "Configure shipping settings",
    color: "text-cyan-600 dark:text-cyan-400",
    bg: "bg-cyan-50 dark:bg-cyan-950/30",
    border:
      "group-hover:border-cyan-200/60 dark:group-hover:border-cyan-800/60",
    iconBg:
      "bg-gradient-to-br from-cyan-400 to-cyan-600 dark:from-cyan-500 dark:to-cyan-700",
    glowBg:
      "group-hover:before:bg-cyan-500/5 dark:group-hover:before:bg-cyan-500/10",
    shadow: "shadow-cyan-500/25 dark:shadow-cyan-500/10",
  },
  {
    title: "Settings",
    href: "/admin/settings",
    icon: Settings,
    description: "Configure store settings",
    color: "text-gray-600 dark:text-gray-400",
    bg: "bg-gray-50 dark:bg-gray-800/30",
    border:
      "group-hover:border-gray-200/60 dark:group-hover:border-gray-700/60",
    iconBg:
      "bg-gradient-to-br from-gray-400 to-gray-600 dark:from-gray-500 dark:to-gray-700",
    glowBg:
      "group-hover:before:bg-gray-500/5 dark:group-hover:before:bg-gray-500/10",
    shadow: "shadow-gray-500/25 dark:shadow-gray-500/10",
  },
];

export function QuickActions() {
  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="space-y-1.5 pb-6">
        <CardTitle className="text-base font-semibold leading-none tracking-tight">
          Quick Actions
        </CardTitle>
        <p className="text-[13px] text-muted-foreground">
          Frequently used actions and shortcuts
        </p>
      </CardHeader>
      <CardContent className="grid gap-2.5 p-0">
        {actions.map((action) => (
          <Button
            key={action.href}
            variant="outline"
            className={`group relative h-auto w-full justify-start overflow-hidden border border-border bg-card p-0 shadow-sm transition-all duration-300 before:absolute before:inset-0 before:transition-all before:duration-300 hover:-translate-y-0.5 hover:border-input hover:shadow-md ${action.border} ${action.glowBg}`}
            asChild
          >
            <a href={action.href} className="relative">
              <div className="flex items-center gap-4 p-3">
                <div
                  className={`group/icon relative flex shrink-0 items-center justify-center rounded-xl ${action.bg} p-0.5`}
                >
                  <div
                    className={`absolute inset-0 rounded-xl ${action.iconBg} opacity-0 transition-opacity duration-500 group-hover:opacity-100`}
                  />
                  <div
                    className={`relative z-10 rounded-lg bg-background/90 p-2 shadow-sm transition-all duration-300 group-hover:shadow ${action.shadow}`}
                  >
                    <action.icon
                      className={`h-5 w-5 ${action.color} transition-transform duration-300 group-hover/icon:scale-110`}
                      style={{
                        stroke: "currentColor",
                        strokeWidth: 2.5,
                      }}
                    />
                  </div>
                </div>
                <div className="flex-1 space-y-1 text-left">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">
                      {action.title}
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {action.description}
                  </p>
                </div>
              </div>
            </a>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
