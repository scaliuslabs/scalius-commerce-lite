// src/components/admin/OrderForm.tsx
import React, { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { toast } from "sonner";
import { OrderStatus } from "@/types/api-responses";
import { generateOrderId } from "@scalius/shared/order-utils";
import { FormActionBar } from "@/components/admin/FormStickyHeader";
import { useNavigate } from "@tanstack/react-router";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import {
  updateOrderItems,
  updateShippingCharge,
  updateDiscountAmount,
} from "@/store/orderStore";
import { getDeliveryLocations } from "@/lib/api.functions";
import { useCreateOrder, useUpdateOrder } from "@/lib/api.mutations";

// Imports for our new, refactored components and types
import {
  orderFormSchema,
  type OrderFormValues,
  type DeliveryLocation,
  type OrderFormProps,
} from "./order-form/types";
import { OrderFormProvider } from "./order-form/OrderFormContext";
import { CustomerInfoSection } from "./order-form/CustomerInfoSection";
import { OrderItemsSection } from "./order-form/OrderItemsSection";
import { SummarySection } from "./order-form/SummarySection";

export function OrderForm({
  products,
  defaultValues,
  isEdit = false,
}: OrderFormProps) {
  const navigate = useNavigate();
  const createMutation = useCreateOrder();
  const updateMutation = useUpdateOrder();
  const form = useForm<OrderFormValues>({
    resolver: zodResolver(orderFormSchema),
    defaultValues: {
      customerName: "",
      customerPhone: "",
      customerEmail: null,
      shippingAddress: "",
      city: "",
      zone: "",
      area: null,
      notes: null,
      items: [],
      discountAmount: null,
      shippingCharge: 0,
      status: OrderStatus.PENDING,
      ...defaultValues,
    },
  });

  const isSubmitting = createMutation.isPending || updateMutation.isPending;
  const [locations, setLocations] = React.useState<{
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  }>({ cities: [], zones: [], areas: [] });
  const [isLoading, setIsLoading] = React.useState({
    zones: false,
    areas: false,
  });

  // --- DATA LOADING AND SIDE EFFECTS ---

  useEffect(() => {
    // Sync default values with nanostore on initial load
    if (defaultValues) {
      updateOrderItems(defaultValues.items || []);
      updateShippingCharge(defaultValues.shippingCharge || 0);
      updateDiscountAmount(defaultValues.discountAmount || null);
    }

    // Load initial data
    loadCities();
    if (isEdit && defaultValues?.city) {
      loadZones(defaultValues.city);
    }
    if (isEdit && defaultValues?.zone) {
      loadAreas(defaultValues.zone);
    }
  }, [isEdit, defaultValues]);

  // Effect to handle Ctrl+Enter for form submission
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (!isSubmitting && form.getValues("items").length > 0) {
          e.preventDefault();
          form.handleSubmit(handleSubmit)();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [isSubmitting, form]);

  // --- API CALLS ---

  const loadCities = async () => {
    try {
      const data = await getDeliveryLocations({ data: { type: "city" } }) as Record<string, unknown>;
      setLocations((prev) => ({ ...prev, cities: (data.locations || []) as DeliveryLocation[] }));
    } catch (error: unknown) {
      console.error("Error loading cities:", error);
      toast.error("Could not load city list. Please refresh the page.");
    }
  };

  const loadZones = async (cityId: string) => {
    if (!cityId) {
      setLocations((prev) => ({ ...prev, zones: [], areas: [] }));
      form.setValue("zone", "");
      form.setValue("area", null);
      return;
    }
    setIsLoading((prev) => ({ ...prev, zones: true }));
    try {
      const data = await getDeliveryLocations({ data: { type: "zone", parentId: cityId } }) as Record<string, unknown>;
      setLocations((prev) => ({ ...prev, zones: (data.locations || []) as DeliveryLocation[], areas: [] }));
      form.setValue("area", null);
    } catch (error: unknown) {
      console.error("Error loading zones:", error);
      toast.error("Could not load zone list. Please refresh the page.");
    } finally {
      setIsLoading((prev) => ({ ...prev, zones: false }));
    }
  };

  const loadAreas = async (zoneId: string) => {
    if (!zoneId) {
      setLocations((prev) => ({ ...prev, areas: [] }));
      form.setValue("area", null);
      return;
    }
    setIsLoading((prev) => ({ ...prev, areas: true }));
    try {
      const data = await getDeliveryLocations({ data: { type: "area", parentId: zoneId } }) as Record<string, unknown>;
      setLocations((prev) => ({ ...prev, areas: (data.locations || []) as DeliveryLocation[] }));
    } catch (error: unknown) {
      console.error("Error loading areas:", error);
      toast.error("Could not load area list. Please refresh the page.");
    } finally {
      setIsLoading((prev) => ({ ...prev, areas: false }));
    }
  };

  // --- FORM SUBMISSION ---

  const handleSubmit: SubmitHandler<OrderFormValues> = (values) => {
    // Find the location objects from state based on the selected IDs
    const city = locations.cities.find((c) => c.id === values.city);
    const zone = locations.zones.find((z) => z.id === values.zone);
    const area = values.area
      ? locations.areas.find((a) => a.id === values.area)
      : null;

    // Enrich the form values with the location names before submission
    values.cityName = city ? city.name : "";
    values.zoneName = zone ? zone.name : "";
    values.areaName = area ? area.name : null;

    if (!isEdit) {
      values.id = generateOrderId();
    }

    const onSuccess = () => {
      void navigate({ to: "/admin/orders" });
    };

    if (isEdit) {
      updateMutation.mutate(
        { ...(values as unknown as Record<string, unknown>), id: values.id || defaultValues?.id } as Record<string, unknown> & { id: string },
        { onSuccess },
      );
    } else {
      createMutation.mutate(
        values as unknown as Record<string, unknown>,
        { onSuccess },
      );
    }
  };

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="-mt-4 pb-6 space-y-4">
          <OrderFormProvider
            form={form}
            products={products}
            isEdit={isEdit}
            locations={locations}
            setLocations={setLocations}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
            loadZones={loadZones}
            loadAreas={loadAreas}
            isSubmitting={isSubmitting}
          >
            <CustomerInfoSection />
            <OrderItemsSection />
            <SummarySection />

            <input type="hidden" {...form.register("cityName")} />
            <input type="hidden" {...form.register("zoneName")} />
            <input type="hidden" {...form.register("areaName")} />
          </OrderFormProvider>
        </form>
      </Form>
      <FormActionBar
        title="Orders"
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        cancelUrl="/admin/orders"
        newUrl="/admin/orders/new"
        newLabel="New Order"
        onSave={() => form.handleSubmit(handleSubmit)()}
      />
    </>
  );
}
