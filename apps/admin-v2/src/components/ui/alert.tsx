import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@scalius/shared/utils";

/** Polaris banner. `destructive` is the critical tone. */
const alertVariants = cva(
  "relative flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-body text-foreground [&>svg]:mt-[calc(0.5lh-0.5rem)] [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-card [&>svg]:text-muted-foreground",
        info: "border-info bg-info-surface [&>svg]:text-info",
        success: "border-success bg-success-surface [&>svg]:text-success",
        warning: "border-warning bg-warning-surface [&>svg]:text-warning",
        destructive: "border-critical bg-critical-surface [&>svg]:text-critical",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-semibold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("space-y-1", className)} {...props} />;
}

/** A leading icon: an element with no children that is not one of the banner's own parts. */
function isLeadingIcon(node: React.ReactNode): node is React.ReactElement {
  return (
    React.isValidElement(node)
    && node.type !== AlertTitle
    && node.type !== AlertDescription
    && (node.props as { children?: unknown }).children == null
  );
}

/**
 * The icon (when the first child is one) sits in its own column; everything
 * else — title, description, or plain text and links — goes in one full-width
 * body, so nothing is squeezed into the icon's column.
 */
function Alert({ className, variant, children, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const items = React.Children.toArray(children);
  const icon = isLeadingIcon(items[0]) ? items[0] : null;
  const body = icon ? items.slice(1) : items;
  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      {icon}
      <div data-slot="alert-body" className="min-w-0 flex-1 space-y-0.5">
        {body}
      </div>
    </div>
  );
}

export { Alert, AlertTitle, AlertDescription };
