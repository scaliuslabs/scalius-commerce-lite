import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.97] active:translate-y-[1px] shadow-[0_2px_0_rgba(0,0,0,0.1)] relative after:absolute after:inset-0 after:rounded-md after:shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] after:pointer-events-none",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-b from-primary to-primary/95 text-primary-foreground shadow-md hover:shadow-lg hover:from-primary/95 hover:to-primary/90 border border-primary/20 after:shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]",
        destructive:
          "bg-gradient-to-b from-destructive to-destructive/95 text-destructive-foreground shadow-md hover:shadow-lg hover:from-destructive/95 hover:to-destructive/90 border border-destructive/20 after:shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]",
        outline:
          "border-2 border-input bg-background/90 shadow-sm hover:bg-accent/50 hover:text-accent-foreground hover:border-accent/50 backdrop-blur-sm after:shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]",
        secondary:
          "bg-gradient-to-b from-secondary to-secondary/95 text-secondary-foreground shadow-sm hover:shadow hover:from-secondary/95 hover:to-secondary/90 border border-secondary/30 after:shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]",
        ghost:
          "hover:bg-accent/40 hover:text-accent-foreground hover:shadow-sm shadow-none after:shadow-none",
        link: "text-primary underline-offset-4 hover:underline hover:text-primary/80 shadow-none after:shadow-none",
        subtle:
          "bg-gradient-to-b from-primary/15 to-primary/10 text-primary hover:from-primary/20 hover:to-primary/15 border border-primary/20 shadow-sm after:shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3 text-xs",
        lg: "h-11 rounded-md px-8 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
