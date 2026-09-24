import React, { createContext, useContext, useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import type {
  OrderFormInput,
  OrderFormValues,
  Product,
} from "./types";
import type { ManualOrderQuotePayload } from "@/lib/api-query-options/orders";
import type { ManualOrderDiscountGuidance } from "./manual-order-discount";

interface OrderFormState {
  form: UseFormReturn<OrderFormInput, unknown, OrderFormValues>;
  products: Product[];
  /** Changing a saved order (amendment) rather than creating one. */
  isEdit: boolean;
  /** Edit only: the delivery method the order was placed with, shown even when the address no longer offers it. */
  savedShippingMethod?: { id: string; name: string } | null;
  /** Totals from the form values, shown until a current server quote exists. */
  localTotals: {
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
  };
  manualQuote: {
    data: ManualOrderQuotePayload | null;
    isCurrent: boolean;
    isLoading: boolean;
    discountLimit: ManualOrderDiscountGuidance | null;
    errorMessage: string | null;
    canRetry: boolean;
    retry: () => void;
  };
}

type Ref<T> = React.RefObject<T | null>;

interface OrderFormContextType extends OrderFormState {
  refs: {
    customerNameRef: Ref<HTMLInputElement>;
    customerPhoneRef: Ref<HTMLInputElement>;
    customerEmailRef: Ref<HTMLInputElement>;
    shippingAddressRef: Ref<HTMLTextAreaElement>;
    cityButtonRef: Ref<HTMLButtonElement>;
    zoneButtonRef: Ref<HTMLButtonElement>;
    areaButtonRef: Ref<HTMLButtonElement>;
    notesRef: Ref<HTMLTextAreaElement>;
    productSearchInputRef: Ref<HTMLInputElement>;
    shippingChargeRef: Ref<HTMLInputElement>;
    discountAmountRef: Ref<HTMLInputElement>;
    addItemButtonRef: Ref<HTMLButtonElement>;
  };
  /** Enter moves focus to the next field (and opens it when it is a picker). */
  handleKeyDown: (e: React.KeyboardEvent, next?: Ref<HTMLElement>) => void;
}

const OrderFormContext = createContext<OrderFormContextType | null>(null);

export function OrderFormProvider({
  children,
  ...state
}: OrderFormState & { children: React.ReactNode }) {
  const refs = {
    customerNameRef: useRef<HTMLInputElement>(null),
    customerPhoneRef: useRef<HTMLInputElement>(null),
    customerEmailRef: useRef<HTMLInputElement>(null),
    shippingAddressRef: useRef<HTMLTextAreaElement>(null),
    cityButtonRef: useRef<HTMLButtonElement>(null),
    zoneButtonRef: useRef<HTMLButtonElement>(null),
    areaButtonRef: useRef<HTMLButtonElement>(null),
    notesRef: useRef<HTMLTextAreaElement>(null),
    productSearchInputRef: useRef<HTMLInputElement>(null),
    shippingChargeRef: useRef<HTMLInputElement>(null),
    discountAmountRef: useRef<HTMLInputElement>(null),
    addItemButtonRef: useRef<HTMLButtonElement>(null),
  };

  const handleKeyDown = (e: React.KeyboardEvent, next?: Ref<HTMLElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const element = next?.current;
    element?.focus();
    if (
      element
      && (element.getAttribute("role") === "combobox"
        || element.getAttribute("aria-haspopup") === "listbox")
    ) {
      element.click();
    }
  };

  return (
    <OrderFormContext.Provider value={{ ...state, refs, handleKeyDown }}>
      {children}
    </OrderFormContext.Provider>
  );
}

export function useOrderForm() {
  const context = useContext(OrderFormContext);
  if (!context) {
    throw new Error("useOrderForm must be used within an OrderFormProvider");
  }
  return context;
}
