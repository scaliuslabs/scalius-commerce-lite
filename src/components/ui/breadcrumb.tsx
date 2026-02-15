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
import { cn } from "@/lib/utils";

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
        "flex items-center text-sm font-medium text-muted-foreground transition-all",
        className,
      )}
      aria-label="Breadcrumb"
    >
      {/* Home Link */}
      <a
        href="/admin"
        className="flex items-center px-2.5 py-1.5 rounded-md hover:bg-accent transition-all duration-300 text-muted-foreground hover:text-primary hover:scale-105 transform"
      >
        <Home className="h-[18px] w-[18px]" />
        <span className="sr-only">Home</span>
      </a>

      {items.map((item, index) => {
        const Icon = iconMap[item.title as keyof typeof iconMap];
        const isLast = index === items.length - 1;

        return (
          <div key={index} className="flex items-center">
            {/* Separator */}
            <div className="mx-1 text-muted-foreground/50">
              <ChevronRight className="h-4 w-4" />
            </div>

            {item.href ? (
              // Clickable breadcrumb item
              <a
                href={item.href}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-accent transition-all duration-300 text-muted-foreground hover:text-primary group relative"
              >
                {Icon && (
                  <Icon className="h-[18px] w-[18px] group-hover:scale-110 transition-transform duration-300" />
                )}
                <span className="group-hover:translate-x-0.5 transition-transform duration-300">
                  {item.title}
                </span>
                {/* Hover effect overlay */}
                <span className="absolute inset-0 rounded-md bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              </a>
            ) : (
              // Current/active breadcrumb item
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-medium relative overflow-hidden",
                  isLast
                    ? "bg-gradient-to-r from-primary/15 to-primary/5 text-primary border border-primary/20"
                    : "text-muted-foreground",
                )}
              >
                {Icon && <Icon className="h-[18px] w-[18px]" />}
                <span>{item.title}</span>
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



