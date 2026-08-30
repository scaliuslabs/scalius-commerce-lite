import * as React from "react";

import { Input } from "~/components/ui/input";
import { cn } from "@scalius/shared/utils";

const MIN_ORDER_ITEM_QUANTITY = 1;
const MAX_ORDER_ITEM_QUANTITY = 99;

interface OrderItemQuantityInputProps {
  quantity: number;
  itemName: string;
  onQuantityChange: (quantity: number) => void;
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
  quantity,
  itemName,
  onQuantityChange,
  className,
}: OrderItemQuantityInputProps) {
  const [draft, setDraft] = React.useState(String(quantity));
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    if (!focusedRef.current) setDraft(String(quantity));
  }, [quantity]);

  return (
    <Input
      type="number"
      inputMode="numeric"
      min={MIN_ORDER_ITEM_QUANTITY}
      max={MAX_ORDER_ITEM_QUANTITY}
      step={1}
      value={draft}
      aria-label={`Quantity for ${itemName}`}
      className={cn("h-8 w-20", className)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        const nextQuantity = parseQuantityDraft(nextDraft);
        if (nextQuantity !== null && nextQuantity !== quantity) {
          onQuantityChange(nextQuantity);
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        const nextQuantity = parseQuantityDraft(draft);
        if (nextQuantity === null) {
          setDraft(String(quantity));
          return;
        }
        setDraft(String(nextQuantity));
        if (nextQuantity !== quantity) onQuantityChange(nextQuantity);
      }}
    />
  );
}
