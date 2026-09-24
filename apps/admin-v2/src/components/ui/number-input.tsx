import * as React from "react";
import { Input } from "./input";

/**
 * Reads a typed number the way merchants type it: Bangla digits (০–৯),
 * grouping commas and spaces are accepted. Empty text is `null`; text that is
 * not a number is `NaN`, so the caller can say so instead of dropping it.
 */
export function parseLocaleNumber(text: string): number | null {
  const latin = text
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/[\s,]/g, "")
    .replace(/[٫।]/g, ".");
  if (latin === "") return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(latin) ? Number(latin) : Number.NaN;
}

function sameNumber(a: number | null, b: number | null): boolean {
  return a === b || (a !== null && b !== null && Number.isNaN(a) && Number.isNaN(b));
}

type NumberInputProps = Omit<React.ComponentProps<"input">, "value" | "onChange" | "type" | "defaultValue"> & {
  value: number | null | undefined;
  /** Called only when the number changes: `null` for empty, `NaN` for text that isn't a number. */
  onValueChange: (value: number | null) => void;
  /** Whole numbers only (quantities): the phone keyboard shows digits only. */
  integer?: boolean;
  /**
   * Money in a currency paid in whole units (taka): the field takes no decimal
   * point, and trying one shows this message at the field instead.
   */
  wholeUnitsMessage?: string;
};

/**
 * A text field for money and quantities. Unlike `type="number"` it keeps
 * Bangla digits and commas instead of silently discarding them, and it never
 * reports a change unless the number itself changed (focus and Tab alone do
 * nothing).
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onValueChange, integer = false, wholeUnitsMessage, onBlur, ...props }, ref) => {
    const shown = value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
    const [text, setText] = React.useState(shown);
    // Follow outside changes (discard, bulk edit) unless the text already means that number.
    if (!sameNumber(parseLocaleNumber(text), value ?? null) && text !== shown) setText(shown);
    return (
      <Input
        ref={ref}
        type="text"
        inputMode={integer || wholeUnitsMessage ? "numeric" : "decimal"}
        autoComplete="off"
        {...props}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          const input = event.currentTarget;
          if (wholeUnitsMessage && /[.٫।]/.test(next)) {
            // Keep what was there and say why at the field.
            input.setCustomValidity(wholeUnitsMessage);
            input.reportValidity();
            return;
          }
          input.setCustomValidity("");
          setText(next);
          const number = parseLocaleNumber(next);
          if (!sameNumber(number, value ?? null)) onValueChange(number);
        }}
        onBlur={(event) => {
          // Show the number as it was understood ("১,২০০" becomes "1200").
          const number = parseLocaleNumber(text);
          if (number !== null && !Number.isNaN(number)) setText(String(number));
          event.currentTarget.setCustomValidity("");
          onBlur?.(event);
        }}
      />
    );
  },
);
NumberInput.displayName = "NumberInput";
