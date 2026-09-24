import * as React from "react";

import { NumberInput } from "~/components/ui/number-input";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";

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

/** A whole number typed in any digits (Latin or Bangla), of any size. */
function isWholeNumber(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function isOrderQuantity(value: number | null): value is number {
  return isWholeNumber(value)
    && value >= MIN_ORDER_ITEM_QUANTITY
    && value <= MAX_ORDER_ITEM_QUANTITY;
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
  const t = useMessages(orderFormMessages);
  // The typed number, kept even while it is empty or too large so the merchant sees what they typed.
  const [draft, setDraft] = React.useState<number | null>(quantity);
  const focusedRef = React.useRef(false);
  const focusStartQuantityRef = React.useRef(quantity);
  const maximumErrorId = React.useId();
  const effectiveMaximum = Math.max(
    0,
    Math.min(MAX_ORDER_ITEM_QUANTITY, maxQuantity),
  );
  const exceedsMaximum = isOrderQuantity(draft) && draft > effectiveMaximum;
  const isDraftValid = !disabled && isOrderQuantity(draft) && !exceedsMaximum;
  const maximumDescriptionId = !disabled && exceedsMaximum && maximumExceededMessage
    ? maximumErrorId
    : undefined;
  const ariaDescribedBy = [describedBy, maximumDescriptionId]
    .filter(Boolean)
    .join(" ") || undefined;

  React.useEffect(() => {
    if (!focusedRef.current) setDraft(quantity);
  }, [quantity]);

  React.useEffect(() => {
    onValidityChange?.(isDraftValid);
  }, [isDraftValid, onValidityChange]);

  /** Commits a valid draft, or puts back the last good quantity. Returns whether the draft was valid. */
  function settle(): boolean {
    if (isOrderQuantity(draft) && draft <= effectiveMaximum) {
      if (draft !== quantity) onQuantityChange(draft);
      return true;
    }
    // A whole number that is too large came from replacing the quantity; go back to where the edit started.
    const fallbackQuantity = isWholeNumber(draft) ? focusStartQuantityRef.current : quantity;
    setDraft(fallbackQuantity);
    if (fallbackQuantity !== quantity) onQuantityChange(fallbackQuantity);
    return false;
  }

  return (
    <div>
      <NumberInput
        id={id}
        integer
        value={draft}
        aria-label={t("quantityFor", { name: itemName })}
        aria-invalid={(!disabled && exceedsMaximum) || undefined}
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        disabled={disabled}
        className={cn("w-20", className)}
        onFocus={() => {
          focusedRef.current = true;
          focusStartQuantityRef.current = quantity;
        }}
        onValueChange={(next) => {
          setDraft(next);
          if (isOrderQuantity(next) && next <= effectiveMaximum) {
            if (next !== quantity) onQuantityChange(next);
          } else if (isWholeNumber(next) && quantity !== focusStartQuantityRef.current) {
            // A multi-digit replacement can have a valid prefix before the
            // completed draft exceeds stock (for example, 2 then 21). Restore
            // the quantity from the start of this edit instead of committing
            // that accidental prefix.
            onQuantityChange(focusStartQuantityRef.current);
          }
        }}
        onBlur={() => {
          focusedRef.current = false;
          settle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (settle()) onEnter?.();
        }}
      />
      {maximumDescriptionId ? (
        <p
          id={maximumErrorId}
          className="mt-1 text-body text-destructive"
          role="alert"
        >
          {maximumExceededMessage}
        </p>
      ) : null}
    </div>
  );
}
