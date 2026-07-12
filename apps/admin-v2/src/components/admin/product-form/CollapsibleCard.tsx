// src/components/admin/product-form/CollapsibleCard.tsx
import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@scalius/shared/utils";

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
      <CardHeader className="px-4 py-3">
        <button
          type="button"
          className="group flex w-full items-center justify-between text-left"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
        >
          <div className="flex-1">
            <h3 className="text-sm font-semibold leading-none transition-colors group-hover:text-primary">
              {title}
            </h3>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <ChevronDown
            className={cn(
              "ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground",
              isOpen && "rotate-180"
            )}
          />
        </button>
      </CardHeader>
      {isOpen && (
        <CardContent className="space-y-3 px-4 pb-4 pt-0 animate-in fade-in-50 duration-150">
          {children}
        </CardContent>
      )}
    </Card>
  );
}
