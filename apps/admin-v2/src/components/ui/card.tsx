import * as React from "react";

import { cn } from "@scalius/shared/utils";

/** Polaris card: white surface, 12px radius, bevel border and a soft shadow. */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} data-slot="card" className={cn("rounded-xl bg-card text-card-foreground shadow-card", className)} {...props} />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex flex-col gap-1 p-4", className)} {...props} />,
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-heading-sm", className)} {...props} />,
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

/**
 * Shopify's card heading with an action: the title block on the left, the
 * action on the right. When the card is narrow (a phone, long Bangla copy)
 * the action drops under the heading instead of squeezing the description
 * into a thin column beside it. `heading` is the title block (a title and a
 * description, or a control that replaces them).
 */
function CardHeading({ heading, action, className }: { heading: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("@container p-4", className)}>
      <div className="flex flex-col items-start gap-3 @md:flex-row @md:justify-between">
        <div className="min-w-0 self-stretch @md:flex-1">{heading}</div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />,
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center gap-2 border-t p-4", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardHeading, CardFooter, CardTitle, CardDescription, CardContent };
