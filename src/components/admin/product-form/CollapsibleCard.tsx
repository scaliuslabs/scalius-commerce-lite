// src/components/admin/product-form/CollapsibleCard.tsx
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface CollapsibleCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function CollapsibleCard({
  title,
  description,
  children,
  defaultOpen = false,
  className,
}: CollapsibleCardProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  return (
    <Card className={className}>
      <CardHeader className="pb-3 pt-4 px-4">
        <button
          type="button"
          className="flex w-full items-start justify-between text-left group"
          onClick={() => setIsOpen(!isOpen)}
        >
          <div className="flex-1">
            <h3 className="text-base font-semibold leading-none group-hover:text-primary transition-colors">
              {title}
            </h3>
            {description && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {description}
              </p>
            )}
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 ml-2 mt-0.5 shrink-0 transition-all duration-200 text-muted-foreground group-hover:text-foreground",
              isOpen && "rotate-180"
            )}
          />
        </button>
      </CardHeader>
      {isOpen && (
        <CardContent className="px-4 pb-4 pt-0 space-y-3 animate-in fade-in-50 slide-in-from-top-2 duration-200">
          {children}
        </CardContent>
      )}
    </Card>
  );
}
