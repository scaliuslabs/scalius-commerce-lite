import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { fieldClassName } from "./input";

export interface NativeSelectProps extends Omit<React.ComponentPropsWithoutRef<"select">, "value" | "defaultValue"> {
  value?: string;
  defaultValue?: string;
  /** Called with the chosen option's value. */
  onValueChange?: (value: string) => void;
  /** Shown while the value is "" (a hidden, unselectable first option). */
  placeholder?: string;
  /** Layout of the field: width, flex or grid placement. */
  className?: string;
}

/**
 * A short, fixed choice (status, sort, a handful of enum values) as a styled
 * native `<select>`, as Polaris does: the platform's own picker on phones,
 * full keyboard and screen-reader support, no scroll quirks. Options are
 * plain `<option>`/`<optgroup>` children. Lists that come from data or can
 * pass about ten entries use SearchableSelect instead.
 */
const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, value, onValueChange, onChange, placeholder, children, ...props }, ref) => (
    <span data-slot="native-select" className={cn("relative inline-flex w-full max-w-full align-middle", className)}>
      {/* eslint-disable-next-line no-restricted-syntax -- the one place a raw select is styled */}
      <select
        ref={ref}
        value={value}
        data-placeholder={placeholder !== undefined && !value ? "" : undefined}
        onChange={(event) => {
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
        className={cn(
          fieldClassName,
          "h-11 w-full cursor-pointer appearance-none truncate py-1 pr-9 disabled:cursor-not-allowed data-[placeholder]:text-muted-foreground sm:h-9 [&_option]:text-foreground",
        )}
        {...props}
      >
        {placeholder !== undefined ? (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  ),
);
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
