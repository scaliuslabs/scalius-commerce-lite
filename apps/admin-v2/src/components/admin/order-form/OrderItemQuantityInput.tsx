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

/**
 * Quantity field. Every whole number the merchant types is kept as typed and
 * passed on, even when it is too large, so the field, the line and the Save
 * check all agree; the reason shows under the field until it is fixed
 * ("Only 22 available."). Only an empty field or text that isn't a number goes
 * back to the last quantity when the field is left.
 */
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
  const [draft, setDraft] = React.useState<number | null>(quantity);
  const focusedRef = React.useRef(false);
  const messageId = React.useId();
  const maximum = Math.max(0, Math.min(MAX_ORDER_ITEM_QUANTITY, maxQuantity));
  // The tighter limit speaks: "Only 22 available." for 150, not "can't be more than 99".
  const stockIsTighter = maxQuantity < MAX_ORDER_ITEM_QUANTITY && maximumExceededMessage !== undefined;
  const message = disabled || !isWholeNumber(draft)
    ? null
    : draft < MIN_ORDER_ITEM_QUANTITY
      ? t("quantityMin")
      : draft <= maximum
        ? null
        : stockIsTighter || draft <= MAX_ORDER_ITEM_QUANTITY
          ? maximumExceededMessage ?? null
          : t("quantityMax");
  const isDraftValid = !disabled
    && isWholeNumber(draft)
    && draft >= MIN_ORDER_ITEM_QUANTITY
    && draft <= maximum;
  const ariaDescribedBy = [describedBy, message ? messageId : null].filter(Boolean).join(" ") || undefined;

  React.useEffect(() => {
    if (!focusedRef.current) setDraft(quantity);
  }, [quantity]);

  React.useEffect(() => {
    onValidityChange?.(isDraftValid);
  }, [isDraftValid, onValidityChange]);

  return (
    <div>
      <NumberInput
        id={id}
        integer
        value={draft}
        aria-label={t("quantityFor", { name: itemName })}
        aria-invalid={message ? true : undefined}
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        disabled={disabled}
        className={cn("w-20", className)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onValueChange={(next) => {
          setDraft(next);
          if (isWholeNumber(next) && next !== quantity) onQuantityChange(next);
        }}
        onBlur={() => {
          focusedRef.current = false;
          // Empty or not a number: show the quantity the line still has.
          if (!isWholeNumber(draft)) setDraft(quantity);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (!isWholeNumber(draft)) setDraft(quantity);
          else if (isDraftValid) onEnter?.();
        }}
      />
      {message ? (
        <p id={messageId} className="mt-1 text-body text-destructive" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
