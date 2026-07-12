import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form } from "../../../ui/form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "../../../ui/form";
import { Button } from "../../../ui/button";
import { Switch } from "../../../ui/switch";
import { Separator } from "../../../ui/separator";
import { toast } from "sonner";
import { useCurrency } from "~/hooks/use-currency";
import { useNavigate } from "@tanstack/react-router";
import { useCreateDiscount, useUpdateDiscount } from "~/lib/api-mutations/discounts";
import { DiscountDetailsSection } from "./DiscountDetailsSection";
import { AppliesToSection } from "./AppliesToSection";
import { MinimumRequirementsSection } from "./MinimumRequirementsSection";
import { UsageLimitsSection } from "./UsageLimitsSection";
import { ActiveDatesSection } from "./ActiveDatesSection";
import { SummaryCard } from "./SummaryCard";
import { formSchema } from "./types";
import type { FormValues, Product, Collection } from "./types";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import {
  normalizeDiscountEndDate,
  normalizeDiscountStartDate,
} from "../shared-validation";

interface AmountOffProductsContainerProps {
  defaultValues?: Partial<Omit<FormValues, "appliesTo"> & { id?: string }>;
  initialSelectedProducts?: Product[];
  initialSelectedCollections?: Collection[];
}

function isSameSelectedProduct(a: Product, b: Product): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.price === b.price &&
    a.discountPercentage === b.discountPercentage
  );
}

function isSameSelectedCollection(a: Collection, b: Collection): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.description === b.description &&
    a.slug === b.slug &&
    a.presentation === b.presentation
  );
}

export function AmountOffProductsContainer({
  defaultValues,
  initialSelectedProducts = [],
  initialSelectedCollections = [],
}: AmountOffProductsContainerProps) {
  const { symbol } = useCurrency();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canToggleStatus = hasPermission(
    ADMIN_PERMISSIONS.DISCOUNTS_TOGGLE_STATUS,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createMut = useCreateDiscount();
  const updateMut = useUpdateDiscount();
  const [selectedProducts, setSelectedProducts] = useState<Product[]>(
    initialSelectedProducts,
  );
  const [selectedCollections, setSelectedCollections] = useState<Collection[]>(
    initialSelectedCollections,
  );

  useEffect(() => {
    if (initialSelectedProducts.length === 0) return;
    const hydratedById = new Map(
      initialSelectedProducts.map((product) => [product.id, product]),
    );
    setSelectedProducts((current) => {
      let changed = false;
      const next = current.map((product) => {
        const hydrated = hydratedById.get(product.id);
        if (!hydrated || isSameSelectedProduct(hydrated, product)) return product;
        changed = true;
        return hydrated;
      });
      return changed ? next : current;
    });
  }, [initialSelectedProducts]);

  useEffect(() => {
    if (initialSelectedCollections.length === 0) return;
    const hydratedById = new Map(
      initialSelectedCollections.map((collection) => [collection.id, collection]),
    );
    setSelectedCollections((current) => {
      let changed = false;
      const next = current.map((collection) => {
        const hydrated = hydratedById.get(collection.id);
        if (!hydrated || isSameSelectedCollection(hydrated, collection)) {
          return collection;
        }
        changed = true;
        return hydrated;
      });
      return changed ? next : current;
    });
  }, [initialSelectedCollections]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: "",
      valueType: "percentage",
      discountValue: 10,
      minPurchaseAmount: null,
      minQuantity: null,
      maxUsesPerOrder: null,
      maxUses: null,
      limitOnePerCustomer: false,
      combineWithProductDiscounts: false,
      combineWithOrderDiscounts: false,
      combineWithShippingDiscounts: false,
      startDate: new Date(),
      endDate: null,
      isActive: false,
      ...defaultValues,
      ...(defaultValues?.startDate && {
        startDate:
          typeof defaultValues.startDate === "string"
            ? new Date(defaultValues.startDate)
            : defaultValues.startDate,
      }),
      ...(defaultValues?.endDate && {
        endDate:
          typeof defaultValues.endDate === "string"
            ? new Date(defaultValues.endDate)
            : defaultValues.endDate,
      }),
      appliesTo: {
        products: initialSelectedProducts.map((p) => p.id),
        collections: initialSelectedCollections.map((c) => c.id),
      },
    },
  });

  useEffect(() => {
    form.setValue(
      "appliesTo",
      {
        products: selectedProducts.map((p) => p.id),
        collections: selectedCollections.map((c) => c.id),
      },
      { shouldValidate: true, shouldDirty: true },
    );
  }, [selectedProducts, selectedCollections, form]);

  const internalHandleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    const discountId = defaultValues?.id;

    const ensuredValues = {
      ...values,
      startDate:
        values.startDate instanceof Date && !isNaN(values.startDate.getTime())
          ? values.startDate
          : new Date(),
    };

    const { appliesTo: _appliesTo, ...restOfValues } = ensuredValues;
    const payload = {
      ...restOfValues,
      type: "amount_off_products" as const,
      maxUsesPerOrder: 1,
      combineWithProductDiscounts: false,
      combineWithOrderDiscounts: false,
      combineWithShippingDiscounts: false,
      appliesToProducts: selectedProducts.map((p) => p.id),
      appliesToCollections: selectedCollections.map((c) => c.id),
      startDate: normalizeDiscountStartDate(ensuredValues.startDate),
      endDate: values.endDate ? normalizeDiscountEndDate(values.endDate) : null,
    };

    try {
      if (discountId) {
        await updateMut.mutateAsync({ id: discountId, ...payload });
      } else {
        await createMut.mutateAsync(payload);
      }
      void navigate({ to: "/admin/discounts" });
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes("Failed"))) {
        toast.error(
          error instanceof Error ? error.message : "An unknown error occurred",
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = form.handleSubmit(internalHandleSubmit);

  return (
    <Form {...form}>
      <form
        method="post"
        action="/admin/discounts"
        onSubmit={handleSubmit}
        className="space-y-4"
        noValidate
      >
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <DiscountDetailsSection form={form} symbol={symbol} />

            <AppliesToSection
              form={form}
              selectedProducts={selectedProducts}
              selectedCollections={selectedCollections}
              onProductsChange={setSelectedProducts}
              onCollectionsChange={setSelectedCollections}
            />

            <MinimumRequirementsSection form={form} symbol={symbol} />

            <UsageLimitsSection form={form} />

            <ActiveDatesSection form={form} />
          </div>

          <div className="xl:sticky xl:top-4">
            <SummaryCard
              form={form}
              symbol={symbol}
              selectedProducts={selectedProducts}
              selectedCollections={selectedCollections}
            />
          </div>
        </div>

        <Separator />

        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center space-x-3">
                <FormControl>
                  <Switch
                    id="isActiveSwitch"
                    checked={field.value}
                    disabled={!canToggleStatus}
                    onCheckedChange={field.onChange}
                    aria-labelledby="isActiveLabel"
                  />
                </FormControl>
                <FormLabel
                  id="isActiveLabel"
                  htmlFor="isActiveSwitch"
                  className="font-medium cursor-pointer"
                >
                  {field.value ? "Active" : "Inactive"}
                </FormLabel>
                <FormDescription>
                  {field.value
                    ? "This discount is currently active."
                    : canToggleStatus
                      ? "This discount is inactive and cannot be used."
                      : "You need discount status permission to change activation."}
                </FormDescription>
              </FormItem>
            )}
          />

          <div className="flex gap-2 self-end sm:self-auto">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: "/admin/discounts" })}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? "Saving..."
                : defaultValues?.id
                  ? "Save Changes"
                  : "Create Discount"}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
