import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { useFieldControl } from "./field-context";

/** Field chrome shared by Input, Textarea and SearchableSelect (see DESIGN.md). */
export const fieldClassName =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 text-body-lg text-foreground placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:bg-critical-surface sm:text-body";

/**
 * The same chrome drawn by a box around an input with a prefix or suffix: the
 * box takes the border, hover, focus ring, invalid and disabled looks of its input.
 */
const affixBoxClassName =
  "flex h-11 w-full min-w-0 cursor-text items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-body-lg text-foreground hover:border-muted-foreground has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-1 has-[input:focus-visible]:ring-ring has-[input:disabled]:cursor-not-allowed has-[input:disabled]:bg-muted has-[input:disabled]:opacity-60 has-[input[aria-invalid=true]]:border-destructive has-[input[aria-invalid=true]]:bg-critical-surface sm:h-9 sm:text-body";

type InputProps = Omit<React.ComponentProps<"input">, "prefix"> & {
  /** Inside the field before the value: a currency symbol ("৳"). Never put it in the label (F3). */
  prefix?: React.ReactNode;
  /** Inside the field after the value: a unit ("%", "g", "days"). */
  suffix?: React.ReactNode;
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, prefix, suffix, ...rest }, ref) => {
  const props = useFieldControl(rest);
  if (prefix === undefined && suffix === undefined) {
    return (
      <input
        type={type}
        className={cn(
          fieldClassName,
          "flex h-11 py-1 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground sm:h-9",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  }
  return (
    <div
      data-slot="input-affix"
      className={cn(affixBoxClassName, className)}
      // A press on the symbol or the unit puts the caret in the input, as a press on the field would.
      onMouseDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        event.currentTarget.querySelector("input")?.focus();
      }}
    >
      {prefix !== undefined ? <span aria-hidden="true" className="shrink-0 text-muted-foreground">{prefix}</span> : null}
      {/* The input keeps the full control height (C1); the box's border sits over its edges. */}
      <input
        type={type}
        ref={ref}
        className="h-11 min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed sm:h-9"
        {...props}
      />
      {suffix !== undefined ? <span aria-hidden="true" className="shrink-0 text-muted-foreground">{suffix}</span> : null}
    </div>
  );
});
Input.displayName = "Input";

export { Input };
export type { InputProps };
