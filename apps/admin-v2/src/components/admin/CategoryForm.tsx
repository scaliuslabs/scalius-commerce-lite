import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { ExternalLink } from "lucide-react";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { CollapsibleCard } from "@/components/admin/product-form/CollapsibleCard";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import {
  createCategory,
  updateCategory,
  type CategoryImageInput,
  type CreateCategoryInput,
} from "@/lib/api-functions/categories";
import { categoryFormSchema, type CategoryFormValues } from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";

interface CategoryFormProps {
  defaultValues?: Partial<CategoryFormValues>;
  isEdit?: boolean;
}

function serializeDate(value: Date | string | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeCategoryImage(
  image: CategoryFormValues["image"],
): CategoryImageInput | null {
  if (!image) return null;
  return {
    ...image,
    createdAt: serializeDate(image.createdAt) ?? new Date().toISOString(),
    updatedAt: serializeDate(image.updatedAt),
  };
}

function toCategoryInput(values: CategoryFormValues): CreateCategoryInput {
  return {
    name: values.name,
    description: values.description,
    slug: values.slug,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription,
    image: serializeCategoryImage(values.image),
  };
}

export function CategoryForm({
  defaultValues,
  isEdit = false,
}: CategoryFormProps) {
  const { getStorefrontPath } = useStorefrontUrl();

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: "",
      description: null,
      slug: "",
      metaTitle: null,
      metaDescription: null,
      image: null,
      slugEdited: false,
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CategoryFormValues>({
    entityName: "Category",
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => createCategory({ data: toCategoryInput(data) }),
    updateFn: (data) =>
      updateCategory({ data: { id: data.id, ...toCategoryInput(data) } }),
    invalidateKeys: [
      queryKeys.categories.list(),
      queryKeys.categories.formOptions(),
      queryKeys.products.stats(),
      ...(isEdit && defaultValues?.id ? [queryKeys.categories.detail(defaultValues.id)] : []),
    ],
    navigateTo: "/admin/categories",
    onError: (_error, message, setFieldError) => {
      if (message.includes("slug already exists")) {
        setFieldError("slug", "This slug is already in use. Please choose a different one.");
        toast.error("Slug already in use", {
          description: "This slug is already in use. Please choose a different one.",
        });
        return true;
      }
      return false;
    },
  });

  // Auto-generate slug from name - ONLY if slug hasn't been manually edited
  React.useEffect(() => {
    if (!isEdit) {
      // Only auto-generate for new categories
      const subscription = form.watch((value, { name }) => {
        if (name === "name" && value.name && !form.getValues("slugEdited")) {
          const slug = value.name
            .toLowerCase()
            .replace(/[^\w\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/^-+|-+$/g, "")
            .replace(/-+/g, "-");
          form.setValue("slug", slug, {
            shouldValidate: true,
          });
        }
      });
      return () => subscription.unsubscribe();
    }
  }, [form, isEdit]);

  const handleSubmit = (values: CategoryFormValues) => {
    submitEntity(values, (field, msg) =>
      form.setError(field as keyof CategoryFormValues, { type: "manual", message: msg }),
    );
  };

  return (
    <FormContainer
      title="Categories"
      entityName={form.watch("name")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl="/admin/categories"
      newUrl="/admin/categories/new"
      newLabel="New Category"
      form={form}
      onSubmit={form.handleSubmit(handleSubmit)}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Name field (standalone, not in a card) */}
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
                    placeholder="Category name"
                    {...field}
                    className="text-base"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Description Card */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <DeferredTiptapEditor
                        content={field.value || ""}
                        onChange={field.onChange}
                        placeholder="Enter category description with rich formatting..."
                        compact={true}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Image Card (collapsible) */}
          <CollapsibleCard
            title="Category Image"
            description="Add an image for your category (optional)"
            defaultOpen={true}
          >
            <FormField
              control={form.control}
              name="image"
              render={({ field }) => (
                <FormItem>
                  <FormImageUploadField
                    value={field.value}
                    onChange={field.onChange}
                    triggerLabel="Select Category Image"
                    changeTriggerLabel="Change Category Image"
                    placeholder="No category image selected"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleCard>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-3">
          {/* Slug Card */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-base">URL & Slug</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center space-x-2">
                      <div className="grow flex items-center rounded-md border border-input bg-background px-3 text-sm ring-offset-background">
                        <span className="text-muted-foreground/80 font-medium">
                          /categories/
                        </span>
                        <FormControl>
                          <input
                            className="grow bg-transparent py-2 outline-none placeholder:text-muted-foreground"
                            placeholder="category-url-slug"
                            {...field}
                            onChange={(e) => {
                              field.onChange(e);
                              // Mark slug as manually edited
                              form.setValue("slugEdited", true, {
                                shouldValidate: false,
                              });
                            }}
                          />
                        </FormControl>
                      </div>
                    </div>
                    <FormDescription className="text-xs text-muted-foreground/80">
                      Auto-generated from the name but can be edited.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isEdit && form.watch("slug") && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2 text-sm font-medium w-full"
                  asChild
                >
                  <a
                    href={getStorefrontPath(
                      `/categories/${form.watch("slug")}`,
                    )}
                    target="_blank"
                  >
                    <ExternalLink className="h-4 w-4" />
                    View on Storefront
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>

          {/* SEO Card (collapsible) */}
          <CollapsibleCard
            title="Search Engine Listing"
            description="Optimize for search engines"
            defaultOpen={false}
          >
            <FormField
              control={form.control}
              name="metaTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meta Title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., Shop Premium Electronics | Your Store Name"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  {field.value && (
                    <CharacterCounter
                      current={field.value.length}
                      recommended={60}
                      max={70}
                    />
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="metaDescription"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meta Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="e.g., Discover our curated collection of premium electronics with fast shipping and expert support."
                      className="resize-none"
                      {...field}
                      value={field.value || ""}
                      rows={3}
                    />
                  </FormControl>
                  {field.value && (
                    <CharacterCounter
                      current={field.value.length}
                      recommended={160}
                      max={200}
                    />
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleCard>
        </div>
      </div>
    </FormContainer>
  );
}
