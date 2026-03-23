import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { toast } from "sonner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../ui/form";
import { Input } from "../../ui/input";
import { FormStickyHeader } from "~/components/admin/FormStickyHeader";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { createCollection, updateCollection } from "~/lib/api.functions";
import { ProductSelectionSection } from "./ProductSelectionSection";
import { LayoutSettingsSection } from "./LayoutSettingsSection";
import {
  collectionFormSchema,
  type CollectionFormValues,
  type CollectionFormProps,
} from "./types";

const DEFAULT_CONFIG = {
  categoryIds: [] as string[],
  productIds: [] as string[],
  maxProducts: 8,
  title: "",
  subtitle: "",
} as const;

export function CollectionForm({
  categories,
  products,
  defaultValues,
  isEdit = false,
}: CollectionFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<CollectionFormValues>({
    resolver: zodResolver(collectionFormSchema),
    defaultValues: {
      name: "",
      type: "manual",
      isActive: true,
      config: { ...DEFAULT_CONFIG },
      ...defaultValues,
    },
  });

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const selectedType = form.watch("type");
  const selectedCategoryIds = form.watch("config.categoryIds");
  const selectedProductIds = form.watch("config.productIds");

  const filteredProducts = React.useMemo(() => {
    if (selectedCategoryIds.length === 0) {
      return products;
    }
    return products.filter((product) =>
      product.categoryId ? selectedCategoryIds.includes(product.categoryId) : false,
    );
  }, [selectedCategoryIds, products]);

  const selectedCategories = React.useMemo(() => {
    return categories.filter((cat) => selectedCategoryIds.includes(cat.id));
  }, [selectedCategoryIds, categories]);

  const selectedProducts = React.useMemo(() => {
    return products.filter((prod) => selectedProductIds.includes(prod.id));
  }, [selectedProductIds, products]);

  const handleSubmit: SubmitHandler<CollectionFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      if (isEdit) {
        const entityId = defaultValues?.id || values.id;
        if (!entityId) throw new Error("Collection ID is required for update");
        await updateCollection({ data: { ...values, id: entityId } });
        queryClient.invalidateQueries({ queryKey: ["collections", "detail", entityId] });
      } else {
        await createCollection({ data: values });
      }

      // Invalidate queries so list page shows fresh data
      queryClient.invalidateQueries({ queryKey: ["collections", "list"] });
      queryClient.invalidateQueries({ queryKey: ["collections", "form-options"] });

      toast.success(
        `Collection ${isEdit ? "updated" : "created"} successfully`,
      );
      void navigate({ to: "/admin/collections" });
    } catch (error: unknown) {
      console.error("Error submitting form:", error);
      toast.error("Failed to save collection", {
        description:
          error instanceof Error
            ? error.message
            : "Failed to save collection. Please try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const addCategory = (categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    if (!currentIds.includes(categoryId)) {
      form.setValue("config.categoryIds", [...currentIds, categoryId]);
    }
  };

  const removeCategory = (categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    form.setValue(
      "config.categoryIds",
      currentIds.filter((id) => id !== categoryId),
    );
  };

  const addProduct = (productId: string) => {
    const currentIds = form.getValues("config.productIds");
    if (!currentIds.includes(productId)) {
      form.setValue("config.productIds", [...currentIds, productId]);
    }
  };

  const removeProduct = (productId: string) => {
    const currentIds = form.getValues("config.productIds");
    form.setValue(
      "config.productIds",
      currentIds.filter((id) => id !== productId),
    );
  };

  return (
    <>
      <FormStickyHeader
        title="Collections"
        entityName={form.watch("name")}
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        cancelUrl="/admin/collections"
        newUrl="/admin/collections/new"
        newLabel="New Collection"
        onSave={() => form.handleSubmit(handleSubmit)()}
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="pt-2 pb-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
            {/* Left Column (2/3) - Main content */}
            <div className="lg:col-span-2 space-y-4">
              {/* Name field */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Name <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Collection name"
                        {...field}
                        className="text-base"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <ProductSelectionSection
                form={form}
                categories={categories}
                filteredProducts={filteredProducts}
                selectedCategories={selectedCategories}
                selectedProducts={selectedProducts}
                selectedCategoryIds={selectedCategoryIds}
                selectedProductIds={selectedProductIds}
                addCategory={addCategory}
                removeCategory={removeCategory}
                addProduct={addProduct}
                removeProduct={removeProduct}
              />
            </div>

            {/* Right Column (1/3) - Settings */}
            <LayoutSettingsSection
              form={form}
              selectedType={selectedType}
              filteredProducts={filteredProducts}
            />
          </div>
        </form>
      </Form>
    </>
  );
}
