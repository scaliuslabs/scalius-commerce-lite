import * as React from "react";
import { cn } from "@scalius/shared/utils";
import { Input, type InputProps } from "./input";
import { toLatinDigits } from "@scalius/shared/phone-input";

/**
 * Reads a typed number the way merchants type it: Bangla (০–৯) or Arabic digits,
 * grouping commas and spaces are accepted. Empty text is `null`; text that is
 * not a number is `NaN`, so the caller can say so instead of dropping it.
 */
export function parseLocaleNumber(text: string): number | null {
  const latin = toLatinDigits(text)
    .replace(/[\s,]/g, "")
    .replace(/[٫।]/g, ".");
  if (latin === "") return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(latin) ? Number(latin) : Number.NaN;
}

function sameNumber(a: number | null, b: number | null): boolean {
  return a === b || (a !== null && b !== null && Number.isNaN(a) && Number.isNaN(b));
}

type NumberInputProps = Omit<InputProps, "value" | "onChange" | "type" | "defaultValue"> & {
  value: number | null | undefined;
  /** Called only when the number changes: `null` for empty, `NaN` for text that isn't a number. */
  onValueChange: (value: number | null) => void;
  /** Whole numbers only (quantities): the phone keyboard shows digits only. */
  integer?: boolean;
  /**
   * Money in a currency paid in whole units (taka): an amount with a fraction
   * ("1234.50") stays as typed, is reported as `NaN` so the form refuses to
   * save it, and shows this message at the field. "1234.00" means 1234.
   */
  wholeUnitsMessage?: string;
  /**
   * Why the typed text is refused, told before `onValueChange` reports `NaN`:
   * `wholeUnitsMessage` for a fraction, `null` for anything else (a valid
   * number, empty, or text that isn't a number). A form shows it in place of
   * its generic "not a number" error.
   */
  onRefusal?: (reason: string | null) => void;
  /** How a number reads once it is settled (saved value, or after leaving the field): "2,500.00" for money. Typing is never rewritten. */
  display?: (value: number) => string;
};

function hasFraction(number: number | null): boolean {
  return number !== null && Number.isFinite(number) && !Number.isInteger(number);
}

/** What the field reports for this text: a fraction in a whole-unit amount is `NaN`. */
function understood(text: string, wholeUnitsMessage: string | undefined): number | null {
  const number = parseLocaleNumber(text);
  return wholeUnitsMessage && hasFraction(number) ? Number.NaN : number;
}

/**
 * A text field for money and quantities. Unlike `type="number"` it keeps
 * Bangla digits and commas instead of silently discarding them, and it never
 * reports a change unless the number itself changed (focus and Tab alone do
 * nothing).
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onValueChange, integer = false, wholeUnitsMessage, onRefusal, display, onBlur, onFocus, onMouseUp, className, ...props }, ref) => {
    const settled = (number: number) => (display ? display(number) : String(number));
    const shown = value === null || value === undefined || Number.isNaN(value) ? "" : settled(value);
    const [text, setText] = React.useState(shown);
    // Follow outside changes (discard, bulk edit) unless the text already means that number.
    if (!sameNumber(understood(text, wholeUnitsMessage), value ?? null) && text !== shown) setText(shown);
    return (
      <Input
        ref={ref}
        type="text"
        inputMode={integer || wholeUnitsMessage ? "numeric" : "decimal"}
        autoComplete="off"
        {...props}
        // Digits of one width, so amounts line up (F4).
        // eslint-disable-next-line shadcn/no-restyle -- numbers are tabular in every number field
        className={cn("tabular-nums", className)}
        value={text}
        // Typing replaces what is there ("0" then "25" is 25, never "025"); the mouse up that
        // ends the click must not clear the selection (Safari does).
        onFocus={(event) => {
          event.currentTarget.select();
          onFocus?.(event);
        }}
        onMouseUp={(event) => {
          event.preventDefault();
          onMouseUp?.(event);
        }}
        onChange={(event) => {
          const next = event.target.value;
          const input = event.currentTarget;
          // Never rewrite what was typed: dropping a decimal point turns
          // "1234.50" into 123450 as the merchant keeps typing.
          setText(next);
          const number = understood(next, wholeUnitsMessage);
          const fractional = Boolean(wholeUnitsMessage) && hasFraction(parseLocaleNumber(next));
          if (fractional) {
            input.setCustomValidity(wholeUnitsMessage!);
            input.reportValidity();
          } else {
            input.setCustomValidity("");
          }
          // The reason first: a form that validates on this change already knows it.
          onRefusal?.(fractional ? wholeUnitsMessage! : null);
          if (!sameNumber(number, value ?? null)) onValueChange(number);
        }}
        onBlur={(event) => {
          // Show the number as it was understood ("১,২০০" becomes "1200");
          // a fraction in a whole-unit amount stays as typed, still flagged.
          const number = parseLocaleNumber(text);
          const fractional = Boolean(wholeUnitsMessage) && hasFraction(number);
          if (number !== null && !Number.isNaN(number) && !fractional) setText(settled(number));
          if (!fractional) event.currentTarget.setCustomValidity("");
          onBlur?.(event);
        }}
      />
    );
  },
);
NumberInput.displayName = "NumberInput";

/** A percentage: a number with "%" inside the field (F3), never "(%)" in the label. */
export const PercentInput = React.forwardRef<HTMLInputElement, Omit<NumberInputProps, "prefix" | "suffix">>((props, ref) => (
  <NumberInput ref={ref} {...props} suffix="%" />
));
PercentInput.displayName = "PercentInput";
