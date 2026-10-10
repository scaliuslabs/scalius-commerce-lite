import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { useFieldControl } from "./field-context";

/** Field chrome shared by Input, Textarea and SearchableSelect (see DESIGN.md). */
export const fieldClassName =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 text-body-lg text-foreground placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:bg-critical-surface sm:text-body";

type InputProps = Omit<React.ComponentProps<"input">, "prefix"> & {
  /** Inside the field before the value: a currency symbol ("৳"). Never put it in the label (F3). */
  prefix?: React.ReactNode;
  /** Inside the field after the value: a unit ("%", "g", "days"). */
  suffix?: React.ReactNode;
};

/** Room for an affix: the field's 12px edge, the affix (its characters, or an icon's 16px) and a 6px gap. */
const room = (affix: React.ReactNode) =>
  `calc(1.125rem + ${typeof affix === "string" || typeof affix === "number" ? `${String(affix).length}ch` : "1rem"})`;

const AFFIX = "pointer-events-none absolute inset-y-0 flex items-center text-muted-foreground";

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, prefix, suffix, style, ...rest }, ref) => {
  const props = useFieldControl(rest);
  const affixed = prefix !== undefined || suffix !== undefined;
  const input = (
    <input
      type={type}
      className={cn(
        fieldClassName,
        "flex h-11 py-1 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground sm:h-9",
        prefix !== undefined && "ps-(--affix-start)",
        suffix !== undefined && "pe-(--affix-end)",
        !affixed && className,
      )}
      style={affixed ? { ...style, "--affix-start": prefix === undefined ? undefined : room(prefix), "--affix-end": suffix === undefined ? undefined : room(suffix) } as React.CSSProperties : style}
      ref={ref}
      {...props}
    />
  );
  if (!affixed) return input;
  // The input is the whole field (its border, focus ring and invalid look); the affixes sit over its padding.
  return (
    <div data-slot="input-affix" className={cn("relative w-full min-w-0", className)}>
      {prefix !== undefined ? <span aria-hidden="true" className={cn(AFFIX, "inset-s-3")}>{prefix}</span> : null}
      {input}
      {suffix !== undefined ? <span aria-hidden="true" className={cn(AFFIX, "inset-e-3")}>{suffix}</span> : null}
    </div>
  );
});
Input.displayName = "Input";

export { Input };
export type { InputProps };
