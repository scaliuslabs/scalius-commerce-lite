import {
  ChevronRight,
  Home,
  Settings,
  Package,
  Users,
  Image,
  List,
  LayoutDashboard,
  ShoppingCart,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@scalius/shared/utils";

interface BreadcrumbProps {
  items: {
    title: string;
    href?: string;
  }[];
  className?: string;
}

// Map of icons for different breadcrumb items
const iconMap = {
  Dashboard: LayoutDashboard,
  Products: Package,
  Orders: ShoppingCart,
  Customers: Users,
  Media: Image,
  Categories: List,
  Settings: Settings,
};

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav
      className={cn(
        "flex min-w-0 items-center overflow-hidden text-sm font-medium text-muted-foreground transition-all",
        className,
      )}
      aria-label="Breadcrumb"
    >
      {/* Home Link */}
      <Link
        to="/admin"
        className="flex shrink-0 items-center px-2.5 py-1.5 rounded-md hover:bg-accent transition-all duration-300 text-muted-foreground hover:text-primary hover:scale-105 transform"
      >
        <Home className="h-[18px] w-[18px]" />
        <span className="sr-only">Home</span>
      </Link>

      {items.map((item, index) => {
        const Icon = iconMap[item.title as keyof typeof iconMap];
        const isLast = index === items.length - 1;

        return (
          <div
            key={index}
            className={cn(
              "min-w-0 items-center",
              isLast ? "flex overflow-hidden" : "hidden shrink-0 md:flex",
            )}
          >
            {/* Separator */}
            <div className="mx-1 shrink-0 text-muted-foreground/50">
              <ChevronRight className="h-4 w-4" />
            </div>

            {item.href ? (
              // Clickable breadcrumb item — use Link for SPA navigation
              <Link
                to={item.href}
                aria-current={isLast ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-all duration-300 hover:bg-accent hover:text-primary",
                  isLast ? "min-w-0 overflow-hidden" : "shrink-0",
                )}
              >
                {Icon && (
                  <Icon className="h-[18px] w-[18px] shrink-0 group-hover:scale-110 transition-transform duration-300" />
                )}
                <span
                  className={cn(
                    "transition-transform duration-300 group-hover:translate-x-0.5",
                    isLast && "min-w-0 truncate",
                  )}
                >
                  {item.title}
                </span>
                {/* Hover effect overlay */}
                <span className="absolute inset-0 rounded-md bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              </Link>
            ) : (
              // Current/active breadcrumb item
              <div
                aria-current={isLast ? "page" : undefined}
                className={cn(
                  "relative flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2.5 py-1.5 font-medium",
                  isLast
                    ? "bg-gradient-to-r from-primary/15 to-primary/5 text-primary border border-primary/20"
                    : "text-muted-foreground",
                )}
              >
                {Icon && <Icon className="h-[18px] w-[18px] shrink-0" />}
                <span className="min-w-0 truncate">{item.title}</span>
                {isLast && (
                  <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" />
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
