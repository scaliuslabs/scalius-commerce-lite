import * as React from "react";

import { Input } from "~/components/ui/input";
import { cn } from "@scalius/shared/utils";

const MIN_ORDER_ITEM_QUANTITY = 1;
const MAX_ORDER_ITEM_QUANTITY = 99;

interface OrderItemQuantityInputProps {
  id?: string;
  quantity: number;
  itemName: string;
  onQuantityChange: (quantity: number) => void;
  onEnter?: () => void;
  onValidityChange?: (isValid: boolean) => void;
  placeholder?: string;
  maxQuantity?: number;
  maximumExceededMessage?: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

function parseQuantityDraft(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < MIN_ORDER_ITEM_QUANTITY ||
    quantity > MAX_ORDER_ITEM_QUANTITY
  ) {
    return null;
  }
  return quantity;
}

export function OrderItemQuantityInput({
  id,
  quantity,
  itemName,
  onQuantityChange,
  onEnter,
  onValidityChange,
  placeholder,
  maxQuantity = MAX_ORDER_ITEM_QUANTITY,
  maximumExceededMessage,
  describedBy,
  disabled = false,
  className,
}: OrderItemQuantityInputProps) {
  const [draft, setDraft] = React.useState(String(quantity));
  const focusedRef = React.useRef(false);
  const focusStartQuantityRef = React.useRef(quantity);
  const maximumErrorId = React.useId();
  const effectiveMaximum = Math.max(
    0,
    Math.min(MAX_ORDER_ITEM_QUANTITY, maxQuantity),
  );
  const parsedDraft = parseQuantityDraft(draft);
  const exceedsMaximum = parsedDraft !== null && parsedDraft > effectiveMaximum;
  const isDraftValid = !disabled && parsedDraft !== null && !exceedsMaximum;
  const maximumDescriptionId = !disabled && exceedsMaximum && maximumExceededMessage
    ? maximumErrorId
    : undefined;
  const ariaDescribedBy = [describedBy, maximumDescriptionId]
    .filter(Boolean)
    .join(" ") || undefined;

  React.useEffect(() => {
    if (!focusedRef.current) setDraft(String(quantity));
  }, [quantity]);

  React.useEffect(() => {
    onValidityChange?.(isDraftValid);
  }, [isDraftValid, onValidityChange]);

  return (
    <div>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={MIN_ORDER_ITEM_QUANTITY}
        max={effectiveMaximum}
        step={1}
        value={draft}
        aria-label={`Quantity for ${itemName}`}
        aria-invalid={(!disabled && exceedsMaximum) || undefined}
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        disabled={disabled}
        className={cn("h-8 w-20", className)}
        onFocus={() => {
          focusedRef.current = true;
          focusStartQuantityRef.current = quantity;
        }}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          const nextQuantity = parseQuantityDraft(nextDraft);
          if (
            nextQuantity !== null
            && nextQuantity <= effectiveMaximum
            && nextQuantity !== quantity
          ) {
            onQuantityChange(nextQuantity);
          } else if (
            /^\d+$/.test(nextDraft)
            && quantity !== focusStartQuantityRef.current
          ) {
            // A multi-digit replacement can have a valid prefix before the
            // completed draft exceeds stock (for example, 2 then 21). Restore
            // the quantity from the start of this edit instead of committing
            // that accidental prefix.
            onQuantityChange(focusStartQuantityRef.current);
          }
        }}
        onBlur={() => {
          focusedRef.current = false;
          const nextQuantity = parseQuantityDraft(draft);
          if (nextQuantity === null || nextQuantity > effectiveMaximum) {
            const fallbackQuantity = /^\d+$/.test(draft)
              ? focusStartQuantityRef.current
              : quantity;
            setDraft(String(fallbackQuantity));
            if (fallbackQuantity !== quantity) {
              onQuantityChange(fallbackQuantity);
            }
            return;
          }
          setDraft(String(nextQuantity));
          if (nextQuantity !== quantity) onQuantityChange(nextQuantity);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const nextQuantity = parseQuantityDraft(draft);
          if (nextQuantity === null || nextQuantity > effectiveMaximum) {
            const fallbackQuantity = /^\d+$/.test(draft)
              ? focusStartQuantityRef.current
              : quantity;
            setDraft(String(fallbackQuantity));
            if (fallbackQuantity !== quantity) {
              onQuantityChange(fallbackQuantity);
            }
            return;
          }
          if (nextQuantity !== quantity) onQuantityChange(nextQuantity);
          onEnter?.();
        }}
      />
      {maximumDescriptionId ? (
        <p
          id={maximumErrorId}
          className="mt-1 max-w-56 text-xs text-destructive"
          role="alert"
        >
          {maximumExceededMessage}
        </p>
      ) : null}
    </div>
  );
}
