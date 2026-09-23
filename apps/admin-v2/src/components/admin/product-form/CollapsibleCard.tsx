import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "../../ui/card";
import { cn } from "@scalius/shared/utils";

interface CollapsibleCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** A card whose body opens from its title row (Attributes, Extra sections, Search engine listing). */
export function CollapsibleCard({
  title,
  description,
  children,
  summary,
  defaultOpen = false,
  className,
}: CollapsibleCardProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const contentId = React.useId();

  return (
    <Card className={className}>
      <CardHeader>
        <button
          type="button"
          className="flex w-full items-start justify-between gap-3 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={isOpen}
          aria-controls={contentId}
          onClick={() => setIsOpen((open) => !open)}
        >
          <span className="min-w-0 space-y-1">
            <span className="block text-heading-md font-semibold">{title}</span>
            {description ? <span className="block text-body text-muted-foreground">{description}</span> : null}
          </span>
          <span className="flex h-6 shrink-0 items-center">
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground", isOpen && "rotate-180")} />
          </span>
        </button>
      </CardHeader>
      {!isOpen && summary ? <CardContent>{summary}</CardContent> : null}
      {isOpen ? (
        <CardContent id={contentId} className="space-y-4">
          {children}
        </CardContent>
      ) : null}
    </Card>
  );
}
