import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@scalius/shared/utils";

/**
 * Polaris equivalents: default = primary, outline = secondary, secondary =
 * filled neutral, ghost = tertiary, link = plain, destructive = critical.
 * States: hover is instant, pressed sinks (inset shadow), focus-visible shows
 * the blue ring, disabled fades, `aria-pressed` marks a selected toggle and
 * `loading` swaps the label for a spinner without changing the width.
 */
const buttonVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-busy:opacity-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-button-primary hover:bg-primary-hover active:shadow-pressed-strong",
        destructive:
          "bg-destructive text-destructive-foreground shadow-button-critical hover:bg-destructive-hover active:shadow-pressed-strong",
        outline:
          "bg-card text-foreground shadow-button hover:bg-muted active:bg-accent active:shadow-pressed aria-pressed:bg-accent aria-pressed:shadow-pressed",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary-hover active:shadow-pressed aria-pressed:bg-secondary-hover aria-pressed:shadow-pressed",
        ghost: "text-foreground hover:bg-accent active:bg-secondary aria-pressed:bg-secondary",
        link: "text-link underline-offset-4 hover:underline active:opacity-75",
      },
      size: {
        default: "h-11 px-4 text-body sm:h-9 sm:px-3",
        sm: "h-9 px-3 text-body sm:h-8 sm:px-2.5",
        lg: "h-11 px-5 text-body-lg",
        icon: "h-11 w-11 sm:h-9 sm:w-9",
        "icon-sm": "h-11 w-11 sm:h-7 sm:w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner in place of the label; the button keeps its width and ignores clicks. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot
          className={cn(buttonVariants({ variant, size }), className)}
          ref={ref}
          aria-disabled={disabled || undefined}
          {...({ ...props, disabled } as React.HTMLAttributes<HTMLElement>)}
        >
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <span className="invisible contents">{children}</span>
            <span className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="animate-spin" aria-hidden="true" />
            </span>
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
