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
import { FormActionBar } from "~/components/admin/FormStickyHeader";
import { useNavigate } from "@tanstack/react-router";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { createCollection, updateCollection } from "~/lib/api-functions/collections";
import { ProductSelectionSection } from "./ProductSelectionSection";
import { LayoutSettingsSection } from "./LayoutSettingsSection";
import {
  collectionFormSchema,
  type CollectionFormValues,
  type CollectionFormProps,
  type Product,
} from "./types";

const DEFAULT_CONFIG = {
  source: "manual" as const,
  categoryIds: [] as string[],
  productIds: [] as string[],
  maxProducts: 8,
  title: "",
  subtitle: "",
} as const;

const EMPTY_PRODUCTS: Product[] = [];
const PENDING_PRODUCT_LABEL = "Loading product label...";

export function CollectionForm({
  categories,
  products = EMPTY_PRODUCTS,
  defaultValues,
  isEdit = false,
}: CollectionFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { collections: collectionActions } = useCatalogActionPermissions();
  const canSave = isEdit ? collectionActions.canEdit : collectionActions.canCreate;
  const [knownProducts, setKnownProducts] = React.useState<Product[]>(products);
  const form = useForm<CollectionFormValues>({
    resolver: zodResolver(collectionFormSchema),
    defaultValues: {
      name: "",
      presentation: "grid",
      isActive: false,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      config: { ...DEFAULT_CONFIG },
      ...defaultValues,
    },
  });

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const selectedPresentation = form.watch("presentation");
  const selectedSource = form.watch("config.source");
  const selectedCategoryIds = form.watch("config.categoryIds");
  const selectedProductIds = form.watch("config.productIds");

  React.useEffect(() => {
    setKnownProducts((current) => {
      const byId = new Map(current.map((product) => [product.id, product]));
      for (const product of products) {
        byId.set(product.id, product);
      }
      return Array.from(byId.values());
    });
  }, [products]);

  const selectedCategories = React.useMemo(() => {
    return categories.filter((cat) => selectedCategoryIds.includes(cat.id));
  }, [selectedCategoryIds, categories]);

  const productsById = React.useMemo(
    () => new Map(knownProducts.map((product) => [product.id, product])),
    [knownProducts],
  );

  const selectedProducts = React.useMemo(() => {
    return selectedProductIds.map(
      (id) => productsById.get(id) ?? { id, name: PENDING_PRODUCT_LABEL },
    );
  }, [productsById, selectedProductIds]);

  const rememberProduct = React.useCallback((product: Product) => {
    setKnownProducts((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      byId.set(product.id, product);
      return Array.from(byId.values());
    });
  }, []);

  const handleSubmit: SubmitHandler<CollectionFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      const submission = {
        ...values,
        config: {
          ...values.config,
          featuredProductId: values.config.featuredProductId || "",
        },
      };
      if (isEdit) {
        const entityId = defaultValues?.id || values.id;
        if (!entityId) throw new Error("Collection ID is required for update");
        const expectedVersion = defaultValues?.version || values.version;
        if (!expectedVersion) throw new Error("Collection version is required for update");
        await updateCollection({ data: { ...submission, id: entityId, expectedVersion } });
        queryClient.invalidateQueries({ queryKey: ["collections", "detail", entityId] });
      } else {
        await createCollection({ data: submission });
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
        description: getServerFnError(error, "Failed to save collection"),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const addCategory = React.useCallback((categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    if (currentIds.length < 90 && !currentIds.includes(categoryId)) {
      form.setValue("config.categoryIds", [...currentIds, categoryId], {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [form]);

  const removeCategory = React.useCallback((categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    form.setValue(
      "config.categoryIds",
      currentIds.filter((id) => id !== categoryId),
      { shouldDirty: true, shouldValidate: true },
    );
  }, [form]);

  const addProduct = React.useCallback((product: Product) => {
    rememberProduct(product);
    const currentIds = form.getValues("config.productIds");
    if (currentIds.length < 90 && !currentIds.includes(product.id)) {
      form.setValue("config.productIds", [...currentIds, product.id], {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [form, rememberProduct]);

  const removeProduct = React.useCallback((productId: string) => {
    const currentIds = form.getValues("config.productIds");
    form.setValue(
      "config.productIds",
      currentIds.filter((id) => id !== productId),
      { shouldDirty: true, shouldValidate: true },
    );
  }, [form]);

  const moveProduct = React.useCallback((productId: string, direction: -1 | 1) => {
    const currentIds = form.getValues("config.productIds");
    const currentIndex = currentIds.indexOf(productId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= currentIds.length) return;
    const reordered = [...currentIds];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex]!, reordered[currentIndex]!];
    form.setValue("config.productIds", reordered, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [form]);

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Form {...form}>
        <form
          method="post"
          onSubmit={canSave
            ? form.handleSubmit(handleSubmit)
            : (event) => event.preventDefault()}
          className="-mt-4 pb-6"
          noValidate
        >
          <div className="mb-4">
            <h1 className="text-xl font-semibold tracking-tight">
              {isEdit ? "Edit Collection" : "Create Collection"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEdit
                ? "Update collection membership, layout, and discovery settings."
                : "Start as a draft, choose its products, and publish when the preview is ready."}
            </p>
            {!canSave ? (
              <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                Read-only access. Collection changes require catalog edit permission.
              </p>
            ) : null}
          </div>
          <fieldset disabled={!canSave} className="grid grid-cols-1 gap-4 disabled:opacity-70 lg:grid-cols-3 lg:gap-5">
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
                        maxLength={100}
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
                selectedSource={selectedSource}
                categories={categories}
                selectedCategories={selectedCategories}
                selectedProducts={selectedProducts}
                selectedCategoryIds={selectedCategoryIds}
                selectedProductIds={selectedProductIds}
                addCategory={addCategory}
                removeCategory={removeCategory}
                addProduct={addProduct}
                removeProduct={removeProduct}
                moveProduct={moveProduct}
              />
            </div>

            {/* Right Column (1/3) - Settings */}
            <LayoutSettingsSection
              form={form}
              selectedPresentation={selectedPresentation}
              knownProducts={knownProducts}
              selectedCategoryIds={selectedSource === "dynamic" ? selectedCategoryIds : []}
              onProductDiscovered={rememberProduct}
            />
          </fieldset>
        </form>
      </Form>
      <FormActionBar
        title="Collections"
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        cancelUrl="/admin/collections"
        newUrl="/admin/collections/new"
        newLabel="New Collection"
        canCreateNew={collectionActions.canCreate}
        canSave={canSave}
        saveDisabledReason={isEdit
          ? "You do not have permission to edit collections."
          : "You do not have permission to create collections."}
        onSave={() => form.handleSubmit(handleSubmit)()}
      />
    </>
  );
}
