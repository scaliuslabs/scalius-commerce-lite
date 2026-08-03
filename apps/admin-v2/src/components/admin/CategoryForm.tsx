import React from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { ResourceDiscoveryReadiness } from "@/components/admin/shared/ResourceDiscoveryReadiness";
import { CollapsibleCard } from "@/components/admin/product-form/CollapsibleCard";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import {
  createCategory,
  updateCategory,
  type CategoryImageInput,
  type CategoryPublishReadiness,
  type CreateCategoryInput,
  type CategoryCreateResult,
  type CategoryMutationResult,
} from "@/lib/api-functions/categories";
import { categoryFormSchema, type CategoryFormValues } from "@/lib/form-schemas";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { readCategoryRevisionConflict } from "@/lib/admin-api-error";

interface CategoryFormProps {
  defaultValues?: Partial<CategoryFormValues>;
  isEdit?: boolean;
  publishReadiness?: CategoryPublishReadiness;
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
    content: values.content,
    slug: values.slug,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription,
    canonicalPath: values.canonicalPath,
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    image: serializeCategoryImage(values.image),
  };
}

function requireCategoryRevision(values: CategoryFormValues): number {
  if (!values.revision || !Number.isInteger(values.revision) || values.revision < 1) {
    throw new Error("Category revision is missing. Reload the page before saving.");
  }
  return values.revision;
}

function getCategoryStatusSummary(
  status: CategoryFormValues["status"],
  ready: boolean,
): string {
  if (status === "published") return "Published";
  if (status === "internal") return "Internal";
  return ready ? "Ready to publish" : "Not ready to publish";
}

export function CategoryForm({
  defaultValues,
  isEdit = false,
  publishReadiness,
}: CategoryFormProps) {
  const navigate = useNavigate();
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: categoryActions } = useCatalogActionPermissions();
  const canSave = isEdit
    ? categoryActions.canEdit
    : categoryActions.canCreate;

  const form = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: "",
      status: "draft",
      description: null,
      content: null,
      slug: "",
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
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
      updateCategory({
        data: {
          id: data.id,
          expectedRevision: requireCategoryRevision(data),
          status: data.status,
          ...toCategoryInput(data),
        },
      }),
    invalidateKeys: [
      queryKeys.categories.list(),
      queryKeys.categories.formOptions(),
      queryKeys.collections.categoryOptions(),
      queryKeys.products.stats(),
      ...(isEdit && defaultValues?.id ? [queryKeys.categories.detail(defaultValues.id)] : []),
    ],
    navigateTo: "/admin/categories",
    onSuccess: (result) => {
      const mutation = result as CategoryMutationResult &
        Partial<CategoryCreateResult>;
      const id = mutation.id || defaultValues?.id;
      form.reset({
        ...form.getValues(),
        ...(id ? { id } : {}),
        revision: mutation.revision,
        status: mutation.status,
      });
      toast.success(isEdit ? "Category saved" : "Category created");
      if (!isEdit && mutation.id) {
        void navigate({
          to: "/admin/categories/$categoryId/edit",
          params: { categoryId: mutation.id },
          replace: true,
        });
      }
    },
    onError: (_error, message, setFieldError) => {
      if (readCategoryRevisionConflict(_error)) {
        toast.error("This category changed in another session", {
          description: "Reload the page before saving so you do not overwrite newer changes.",
        });
        return true;
      }
      if (message.includes("exists in trash")) {
        const detail = "A trashed category already uses this URL. Restore it or choose another slug.";
        setFieldError("slug", detail);
        toast.error("Slug belongs to a trashed category", { description: detail });
        return true;
      }
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
      newLabel="New category"
      canCreateNew={categoryActions.canCreate}
      canSave={canSave}
      saveDisabledReason={isEdit
        ? "You do not have permission to edit categories."
        : "You do not have permission to create categories."}
      saveLabel={isEdit ? "Save changes" : "Create category"}
      form={form}
      onSubmit={form.handleSubmit(handleSubmit)}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 lg:gap-4">
        {/* Left Column (2/3) */}
        <div className="space-y-3 lg:col-span-2">
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
                    className="min-h-11 text-base md:h-9 md:min-h-9"
                    maxLength={100}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Card className="overflow-hidden">
            <Tabs defaultValue="introduction" className="w-full">
              <TabsList className="h-11 w-full justify-start rounded-none border-b bg-transparent p-0 md:h-9">
                <TabsTrigger
                  value="introduction"
                  className="h-11 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent md:h-9"
                >
                  Introduction
                </TabsTrigger>
                <TabsTrigger
                  value="below-products"
                  className="h-11 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent md:h-9"
                >
                  Below products
                </TabsTrigger>
              </TabsList>

              <TabsContent value="introduction" className="m-0 p-3">
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <DeferredTiptapEditor
                          content={field.value || ""}
                          onChange={field.onChange}
                          placeholder="Introduce this category above the product list"
                          ariaLabel="Category introduction"
                          compact={true}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </TabsContent>

              <TabsContent value="below-products" className="m-0 p-3">
                <FormField
                  control={form.control}
                  name="content"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <DeferredTiptapEditor
                          content={field.value || ""}
                          onChange={field.onChange}
                          placeholder="Add a buying guide, specifications, comparisons, or FAQs"
                          ariaLabel="Category content below products"
                          compact={true}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </TabsContent>
            </Tabs>
          </Card>

          {/* Image Card (collapsible) */}
          <CollapsibleCard
            title="Image"
            defaultOpen={Boolean(defaultValues?.image)}
          >
            <FormField
              control={form.control}
              name="image"
              render={({ field }) => (
                <FormItem>
                  <FormImageUploadField
                    value={field.value}
                    onChange={field.onChange}
                    triggerLabel="Select image"
                    changeTriggerLabel="Change image"
                    placeholder="No image selected"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleCard>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm">Status</CardTitle>
                {!isEdit ? <Badge variant="secondary">Draft</Badge> : null}
              </div>
            </CardHeader>
            {isEdit ? (
              <CardContent className="space-y-3 px-4 pb-4 pt-0">
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="sr-only">Category status</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger
                            aria-label="Category status"
                            className="min-h-11 md:h-9 md:min-h-9"
                          >
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem
                            value="published"
                            disabled={
                              form.getValues("status") !== "published" &&
                              publishReadiness?.ready === false
                            }
                          >
                            Published
                          </SelectItem>
                          <SelectItem value="internal">Internal</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {publishReadiness ? (
                  <div className="rounded-md border bg-muted/20 p-3 text-xs">
                    <div className="flex items-start gap-2">
                      {publishReadiness.ready ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium text-foreground">
                          {getCategoryStatusSummary(
                            form.getValues("status"),
                            publishReadiness.ready,
                          )}
                        </p>
                        <p className="text-muted-foreground">
                          {publishReadiness.eligibleProductCount} active{" "}
                          {publishReadiness.eligibleProductCount === 1
                            ? "product"
                            : "products"}
                        </p>
                      </div>
                    </div>
                    {publishReadiness.blockers.map((blocker) => (
                      <p key={blocker.code} className="mt-2 text-amber-700 dark:text-amber-400">
                        {blocker.message}
                      </p>
                    ))}
                    {publishReadiness.warnings.map((warning) => (
                      <p key={warning.code} className="mt-2 text-muted-foreground">
                        {warning.message}
                      </p>
                    ))}
                  </div>
                ) : null}

                {form.watch("status") === "published" && form.watch("slug") ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 w-full gap-2 text-xs md:h-8 md:min-h-8"
                    asChild
                  >
                    <a
                      href={getStorefrontPath(
                        `/categories/${form.watch("slug")}`,
                      )}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View on storefront
                    </a>
                  </Button>
                ) : null}
              </CardContent>
            ) : null}
          </Card>

          {/* SEO Card (collapsible) */}
          <CollapsibleCard
            title="Search and discovery"
            defaultOpen={false}
            summary={
              <div className="rounded-md border bg-muted/15 p-2.5">
                <p className="truncate text-xs font-medium text-foreground">
                  {form.watch("metaTitle")?.trim() ||
                    form.watch("name")?.trim() ||
                    "Search preview"}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-emerald-700 dark:text-emerald-400">
                  /categories/{form.watch("slug")?.trim() || "category-url"}
                </p>
                {form.watch("metaDescription")?.trim() ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {form.watch("metaDescription")?.trim()}
                  </p>
                ) : null}
              </div>
            }
          >
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    URL <span className="text-destructive">*</span>
                  </FormLabel>
                  <div className="flex items-center gap-1.5">
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      /categories/
                    </span>
                    <FormControl>
                      <Input
                        placeholder="category-url"
                        maxLength={100}
                        className="min-h-11 md:h-9 md:min-h-9"
                        {...field}
                        onChange={(event) => {
                          field.onChange(event);
                          form.setValue("slugEdited", true, {
                            shouldValidate: false,
                          });
                        }}
                      />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="metaTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Page title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Category title"
                      className="min-h-11 md:h-9 md:min-h-9"
                      {...field}
                      value={field.value || ""}
                      maxLength={70}
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
                  <FormLabel>Meta description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Category description"
                      className="min-h-24 resize-none"
                      {...field}
                      value={field.value || ""}
                      rows={3}
                      maxLength={200}
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

            <FormField
              control={form.control}
              name="canonicalPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Canonical path</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="/categories/shoes"
                      className="min-h-11 md:h-9 md:min-h-9"
                      {...field}
                      value={field.value || ""}
                      onChange={(event) => {
                        field.onChange(event.target.value || null);
                      }}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Optional same-store path for duplicate or campaign pages. Leave blank to use this category page.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-2">
              <FormField
                control={form.control}
                name="noIndex"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm font-medium">
                        Prevent search indexing
                      </FormLabel>
                      <FormDescription className="text-xs">
                        Keep the category page public, but ask search engines not to index it.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="excludeFromSitemap"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm font-medium">
                        Hide from sitemap
                      </FormLabel>
                      <FormDescription className="text-xs">
                        Keep the page public, but remove it from category sitemap XML.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <ResourceDiscoveryReadiness
              kind="category"
              slug={form.watch("slug")}
              canonicalPath={form.watch("canonicalPath")}
              noIndex={form.watch("noIndex")}
              excludeFromSitemap={form.watch("excludeFromSitemap")}
            />
          </CollapsibleCard>
        </div>
      </div>
    </FormContainer>
  );
}
