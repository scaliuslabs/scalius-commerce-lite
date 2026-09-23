import { ChevronRight, Home } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@scalius/shared/utils";

interface BreadcrumbProps {
  items: {
    title: string;
    href?: string;
  }[];
  className?: string;
}

const crumbClassName = "flex min-h-11 items-center gap-1.5 rounded-lg px-2 sm:min-h-8";

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav
      className={cn("flex min-w-0 items-center overflow-hidden text-body font-medium text-muted-foreground", className)}
      aria-label="Breadcrumb"
    >
      <Link
        to="/admin"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-accent hover:text-foreground sm:h-8 sm:w-8"
      >
        <Home className="size-4" />
        <span className="sr-only">Home</span>
      </Link>

      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <div key={index} className={cn("min-w-0 items-center", isLast ? "flex overflow-hidden" : "hidden shrink-0 md:flex")}>
            <ChevronRight className="size-4 shrink-0" />
            {item.href ? (
              <Link
                to={item.href}
                aria-current={isLast ? "page" : undefined}
                className={cn(
                  crumbClassName,
                  "hover:bg-accent hover:text-foreground",
                  isLast ? "min-w-0 overflow-hidden text-foreground" : "shrink-0",
                )}
              >
                <span className={cn(isLast && "min-w-0 truncate")}>{item.title}</span>
              </Link>
            ) : (
              <div
                aria-current={isLast ? "page" : undefined}
                className={cn(crumbClassName, "min-w-0 overflow-hidden", isLast && "text-foreground")}
              >
                <span className="min-w-0 truncate">{item.title}</span>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
