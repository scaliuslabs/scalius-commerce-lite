// src/components/admin/OrderForm.tsx
import React, { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { OrderStatus } from "../../db/schema";
import { generateOrderId } from "@/lib/order-utils";
import {
  updateOrderItems,
  updateShippingCharge,
  updateDiscountAmount,
} from "@/store/orderStore";

// Imports for our new, refactored components and types
import {
  orderFormSchema,
  type OrderFormValues,
  type DeliveryLocation,
  type OrderFormProps,
} from "./order-form/types";
import { OrderFormProvider, useOrderForm } from "./order-form/OrderFormContext";
import { CustomerInfoSection } from "./order-form/CustomerInfoSection";
import { OrderItemsSection } from "./order-form/OrderItemsSection";
import { SummarySection } from "./order-form/SummarySection";

// A small component for the final action buttons
function FormActions() {
  const { isSubmitting, isEdit, form, refs } = useOrderForm();
  return (
    <div className="flex justify-end space-x-4">
      <Button variant="outline" type="button" asChild>
        <a href="/admin/orders">Cancel</a>
      </Button>
      <div className="flex flex-col items-end gap-1">
        <Button
          ref={refs.submitButtonRef}
          type="submit"
          disabled={isSubmitting || form.getValues("items").length === 0}
          className="px-8"
        >
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? "Update Order" : "Create Order"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Press Ctrl+Enter to submit
        </span>
      </div>
    </div>
  );
}

export function OrderForm({
  products,
  defaultValues,
  isEdit = false,
}: OrderFormProps) {
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

  const [isSubmitting, setIsSubmitting] = React.useState(false);
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
      const res = await fetch("/api/settings/delivery-locations?type=city");
      if (!res.ok) throw new Error("Failed to load cities");
      const data = await res.json();
      setLocations((prev) => ({ ...prev, cities: data.data || [] }));
    } catch (error) {
      console.error("Error loading cities:", error);
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
      const res = await fetch(
        `/api/settings/delivery-locations?type=zone&parentId=${cityId}`,
      );
      if (!res.ok) throw new Error("Failed to load zones");
      const data = await res.json();
      setLocations((prev) => ({ ...prev, zones: data.data || [], areas: [] }));
      form.setValue("area", null);
    } catch (error) {
      console.error("Error loading zones:", error);
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
      const res = await fetch(
        `/api/settings/delivery-locations?type=area&parentId=${zoneId}`,
      );
      if (!res.ok) throw new Error("Failed to load areas");
      const data = await res.json();
      setLocations((prev) => ({ ...prev, areas: data.data || [] }));
    } catch (error) {
      console.error("Error loading areas:", error);
    } finally {
      setIsLoading((prev) => ({ ...prev, areas: false }));
    }
  };

  // --- FORM SUBMISSION ---

  const handleSubmit: SubmitHandler<OrderFormValues> = async (values) => {
    setIsSubmitting(true);
    try {
      const endpoint = isEdit ? `/api/orders/${values.id}` : "/api/orders";
      const method = isEdit ? "PUT" : "POST";

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

      // Sanitize phone number
      const phone = values.customerPhone.replace(/^\+?880/, "").trim();
      values.customerPhone = phone.startsWith("1") ? "0" + phone : phone;

      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to save order");
      }

      window.location.href = "/admin/orders";
    } catch (error) {
      console.error("Error submitting form:", error);
      alert(
        `Failed to save order: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
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

          <FormActions />
        </OrderFormProvider>
      </form>
    </Form>
  );
}
