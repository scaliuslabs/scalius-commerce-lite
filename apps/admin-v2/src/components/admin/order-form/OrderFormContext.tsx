import React, { createContext, useContext, useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import type {
  DeliveryLocation,
  OrderFormValues,
  Product,
} from "./types";

// Define the shape of the context state
interface OrderFormContextType {
  form: UseFormReturn<OrderFormValues>;
  products: Product[];
  isEdit: boolean;
  locations: {
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  };
  setLocations: React.Dispatch<React.SetStateAction<{
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  }>>;
  isLoading: {
    zones: boolean;
    areas: boolean;
  };
  setIsLoading: React.Dispatch<React.SetStateAction<{
    zones: boolean;
    areas: boolean;
  }>>;
  loadZones: (cityId: string) => Promise<void>;
  loadAreas: (zoneId: string) => Promise<void>;
  isSubmitting: boolean;
  refs: {
    customerNameRef: React.RefObject<HTMLInputElement | null>;
    customerPhoneRef: React.RefObject<HTMLInputElement | null>;
    customerEmailRef: React.RefObject<HTMLInputElement | null>;
    shippingAddressRef: React.RefObject<HTMLTextAreaElement | null>;
    cityButtonRef: React.RefObject<HTMLButtonElement | null>;
    zoneButtonRef: React.RefObject<HTMLButtonElement | null>;
    areaButtonRef: React.RefObject<HTMLButtonElement | null>;
    notesRef: React.RefObject<HTMLTextAreaElement | null>;
    productSearchButtonRef: React.RefObject<HTMLButtonElement | null>;
    shippingChargeRef: React.RefObject<HTMLInputElement | null>;
    discountAmountRef: React.RefObject<HTMLInputElement | null>;
    statusButtonRef: React.RefObject<HTMLButtonElement | null>;
    submitButtonRef: React.RefObject<HTMLButtonElement | null>;
    addItemButtonRef: React.RefObject<HTMLButtonElement | null>;
  };
  handleKeyDown: (
    e: React.KeyboardEvent,
    nextElementRef?: React.RefObject<HTMLElement | null>,
  ) => void;
}

// Create the context with a null default value
const OrderFormContext = createContext<OrderFormContextType | null>(null);

// Create a provider component
interface OrderFormProviderProps {
  children: React.ReactNode;
  form: UseFormReturn<OrderFormValues>;
  products: Product[];
  isEdit: boolean;
  locations: {
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  };
  setLocations: React.Dispatch<React.SetStateAction<{
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  }>>;
  isLoading: {
    zones: boolean;
    areas: boolean;
  };
  setIsLoading: React.Dispatch<React.SetStateAction<{
    zones: boolean;
    areas: boolean;
  }>>;
  loadZones: (cityId: string) => Promise<void>;
  loadAreas: (zoneId: string) => Promise<void>;
  isSubmitting: boolean;
}

export const OrderFormProvider: React.FC<OrderFormProviderProps> = ({
  children,
  ...props
}) => {
  // All refs for keyboard navigation are centralized here
  const customerNameRef = useRef<HTMLInputElement>(null);
  const customerPhoneRef = useRef<HTMLInputElement>(null);
  const customerEmailRef = useRef<HTMLInputElement>(null);
  const shippingAddressRef = useRef<HTMLTextAreaElement>(null);
  const cityButtonRef = useRef<HTMLButtonElement>(null);
  const zoneButtonRef = useRef<HTMLButtonElement>(null);
  const areaButtonRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const productSearchButtonRef = useRef<HTMLButtonElement>(null);
  const shippingChargeRef = useRef<HTMLInputElement>(null);
  const discountAmountRef = useRef<HTMLInputElement>(null);
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const addItemButtonRef = useRef<HTMLButtonElement>(null);

  const refs = {
    customerNameRef,
    customerPhoneRef,
    customerEmailRef,
    shippingAddressRef,
    cityButtonRef,
    zoneButtonRef,
    areaButtonRef,
    notesRef,
    productSearchButtonRef,
    shippingChargeRef,
    discountAmountRef,
    statusButtonRef,
    submitButtonRef,
    addItemButtonRef,
  };

  const handleKeyDown = (
    e: React.KeyboardEvent,
    nextElementRef?: React.RefObject<HTMLElement | null>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      nextElementRef?.current?.focus();
      // Special handling for combobox/popover triggers to open them on Enter
      if (
        nextElementRef?.current &&
        (nextElementRef.current.getAttribute("role") === "combobox" ||
          nextElementRef.current.getAttribute("aria-haspopup") === "listbox")
      ) {
        nextElementRef.current.click();
      }
    }
  };

  const value = {
    ...props,
    refs,
    handleKeyDown,
  };

  return (
    <OrderFormContext.Provider value={value}>
      {children}
    </OrderFormContext.Provider>
  );
};

// Custom hook for easily consuming the context in child components
export const useOrderForm = () => {
  const context = useContext(OrderFormContext);
  if (!context) {
    throw new Error("useOrderForm must be used within an OrderFormProvider");
  }
  return context;
};