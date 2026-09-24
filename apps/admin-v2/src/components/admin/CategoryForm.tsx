import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { RichContent } from "../ui/rich-content";
import { NativeSelect } from "../ui/native-select";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { SearchListingCard } from "@/components/admin/search-listing/SearchListingCard";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { postApiV1AdminCategories, putApiV1AdminCategoriesById } from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import type { CategoryDetail } from "@/lib/api-query-options/categories";
import { categoryFormSchema, type CategoryFormInput, type CategoryFormValues } from "@/lib/form-schemas";
import { getPlainText } from "@/lib/format-utils";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { readCategoryRevisionConflict } from "@/lib/admin-api-error";
import { useMessages } from "~/i18n";
import { categoryFormMessages } from "~/i18n/category-form";

interface CategoryFormProps {
  defaultValues?: Partial<CategoryFormValues>;
  isEdit?: boolean;
  publishReadiness?: CategoryDetail["publishReadiness"];
}

type CategoryInput = ApiBody<typeof postApiV1AdminCategories>;
function toCategoryInput(values: CategoryFormValues): CategoryInput {
  const { image } = values;
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
    image: image
      ? {
          id: image.id,
          url: image.url,
          filename: image.filename,
          size: image.size,
          createdAt: image.createdAt.toISOString(),
        }
      : null,
  };
}

function toHandle(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function CategoryForm({ defaultValues, isEdit = false, publishReadiness }: CategoryFormProps) {
  const navigate = useNavigate();
  const t = useMessages(categoryFormMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: categoryActions } = useCatalogActionPermissions();
  const canSave = isEdit ? categoryActions.canEdit : categoryActions.canCreate;
  const handleEdited = useRef(isEdit);

  const form = useForm<CategoryFormInput, unknown, CategoryFormValues>({
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
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CategoryFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => apiData(postApiV1AdminCategories({ body: { status: data.status, ...toCategoryInput(data) } })),
    updateFn: (data) => {
      if (!data.revision || !Number.isInteger(data.revision) || data.revision < 1) {
        throw new Error(t("reloadToSave"));
      }
      return apiData(putApiV1AdminCategoriesById({
        path: { id: data.id },
        body: { expectedRevision: data.revision, status: data.status, ...toCategoryInput(data) },
      }));
    },
    invalidateKeys: [
      queryKeys.categories.list(),
      queryKeys.categories.formOptions(),
      queryKeys.collections.categoryOptions(),
      queryKeys.products.stats(),
      ...(isEdit && defaultValues?.id ? [queryKeys.categories.detail(defaultValues.id)] : []),
    ],
    onSuccess: (result) => {
      const mutation = result as ApiResult<typeof putApiV1AdminCategoriesById> &
        Partial<ApiResult<typeof postApiV1AdminCategories>>;
      const id = mutation.id || defaultValues?.id;
      form.reset({
        ...form.getValues(),
        ...(id ? { id } : {}),
        revision: mutation.revision,
        status: mutation.status,
      });
      if (!isEdit && mutation.id) {
        void navigate({
          to: "/admin/categories/$categoryId/edit",
          params: { categoryId: mutation.id },
          replace: true,
        });
      }
    },
    onError: (error, message) => {
      if (readCategoryRevisionConflict(error)) return t("conflict");
      const address = message.includes("exists in trash")
        ? t("addressInTrash")
        : message.includes("slug already exists")
          ? t("addressTaken")
          : undefined;
      if (address) form.setError("slug", { type: "server", message: address });
      return address;
    },
  });

  // New categories take their web address from the name until the merchant edits it.
  useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === "name" && !handleEdited.current) {
        form.setValue("slug", toHandle(value.name ?? ""));
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const name = form.watch("name");
  const status = form.watch("status");
  const description = form.watch("description");
  const errors = form.formState.errors;
  const committedStatus = defaultValues?.status ?? "draft";
  // An active category with no active products shows an empty page on the store.
  const staysEmpty = status === "published" && (publishReadiness?.eligibleProductCount ?? 0) === 0;

  return (
    <FormContainer
      heading={isEdit ? defaultValues?.name || t("category") : t("addCategory")}
      isSubmitting={isSubmitting}
      backUrl="/admin/categories"
      canSave={canSave}
      form={form}
      onSave={submitEntity}
      unsavedLabel={isEdit ? undefined : t("unsavedCategory")}
      savedMessage={t("saved")}
    >
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("name")}</FormLabel>
                    <FormControl>
                      <Input placeholder={t("namePlaceholder")} maxLength={100} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("description")}</FormLabel>
                    {canSave ? (
                      <DeferredTiptapEditor
                        content={field.value ?? ""}
                        onChange={field.onChange}
                        placeholder={t("descriptionPlaceholder")}
                        ariaLabel={t("description")}
                        compact
                      />
                    ) : (
                      <RichContent content={field.value ?? ""} />
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("belowProducts")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    {canSave ? (
                      <DeferredTiptapEditor
                        content={field.value ?? ""}
                        onChange={field.onChange}
                        placeholder={t("belowProductsPlaceholder")}
                        ariaLabel={t("belowProducts")}
                        compact
                      />
                    ) : (
                      <RichContent content={field.value ?? ""} />
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("image")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="image"
                render={({ field }) => (
                  <FormItem>
                    <FormImageUploadField
                      value={field.value}
                      onChange={field.onChange}
                      triggerLabel={t("chooseImage")}
                      changeTriggerLabel={t("changeImage")}
                      placeholder={t("noImage")}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <SearchListingCard
            resource="category"
            value={{
              title: form.watch("metaTitle") ?? "",
              description: form.watch("metaDescription") ?? "",
              handle: form.watch("slug") ?? "",
              hidden: form.watch("noIndex") === true,
            }}
            onChange={(next) => {
              if (next.title !== undefined) {
                form.setValue("metaTitle", next.title || null, { shouldDirty: true });
              }
              if (next.description !== undefined) {
                form.setValue("metaDescription", next.description || null, { shouldDirty: true });
              }
              if (next.handle !== undefined) {
                handleEdited.current = true;
                form.setValue("slug", next.handle, { shouldDirty: true, shouldValidate: true });
                // A saved main address must follow the category's own address.
                if (form.getValues("canonicalPath") !== null) {
                  form.setValue("canonicalPath", `/categories/${next.handle}`, { shouldDirty: true });
                }
              }
              if (next.hidden !== undefined) {
                form.setValue("noIndex", next.hidden, { shouldDirty: true });
              }
            }}
            fallbackTitle={name ?? ""}
            fallbackDescription={getPlainText(description ?? null, 320)}
            errors={{
              title: errors.metaTitle?.message,
              description: errors.metaDescription?.message,
              handle: errors.slug?.message,
            }}
            disabled={!canSave}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("status")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <NativeSelect value={field.value} onValueChange={field.onChange} disabled={!canSave} aria-label={t("status")}>
                        <option value="published">{t("active")}</option>
                        <option value="draft">{t("draft")}</option>
                        <option value="internal">{t("hidden")}</option>
                      </NativeSelect>
                    </FormControl>
                    <FormDescription>
                      {t(status === "published" ? "activeHelp" : status === "internal" ? "hiddenHelp" : "draftHelp")}
                    </FormDescription>
                    {staysEmpty ? <p className="text-body text-warning">{t("staysEmpty")}</p> : null}
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isEdit && committedStatus === "published" && defaultValues?.slug ? (
                <Button type="button" variant="outline" asChild>
                  <a
                    href={getStorefrontPath(`/categories/${defaultValues.slug}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink />
                    {t("viewOnStore")}
                  </a>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </FormContainer>
  );
}
