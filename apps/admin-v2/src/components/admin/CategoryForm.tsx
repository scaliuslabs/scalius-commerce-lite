import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { presenceKey } from "~/lib/realtime/store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { FormField } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { RichContent } from "../ui/rich-content";
import { SearchableSelect } from "../ui/searchable-select";
import { TemplateSelect } from "@/components/admin/catalog/TemplateSelect";
import { CategoryAttributeSetCard } from "@/components/admin/catalog/CategoryAttributeSetCard";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { SaveConflict } from "@/components/admin/shared/SaveBar";
import { copyValues, rebaseForm } from "@/components/admin/shared/use-form-save-bar";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import type { MediaFile } from "./media-manager";
import { SearchListingCard, autoHandleFor } from "@/components/admin/search-listing/SearchListingCard";
import { useTranslateMenuItem } from "@/components/admin/translations/TranslateMenuItem";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { postApiV1AdminCategories, putApiV1AdminCategoriesById } from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import {
  categoryFormOptionsQueryOptions,
  categoryQueryOptions,
  type CategoryDetail,
} from "@/lib/api-query-options/categories";
import { categoryPathLabel, indexCategories } from "@/lib/category-tree";
import { parentChoices } from "@/lib/category-parent-choices";
import { categoryFormSchema, type CategoryFormInput, type CategoryFormValues } from "@/lib/form-schemas";
import { getPlainText } from "@/lib/format-utils";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { readAdminApiErrorCode } from "@/lib/admin-api-error";
import { readCategoryRevisionConflict } from "@/lib/admin-api-conflicts";
import { useMessages } from "~/i18n";
import { categoryFormMessages } from "~/i18n/category-form";
import { CustomFieldsCard } from "./custom-fields/CustomFieldsCard";
import { AppActionsMenu } from "./apps/ui/AppActions";
import { AppResourceCards } from "./apps/ui/AppResourceCards";
import { richTextOrNull } from "~/lib/rich-text-value";
import { Field, ReadOnlyValue } from "~/components/ui/field";

interface CategoryFormProps {
  defaultValues?: Partial<CategoryFormValues>;
  isEdit?: boolean;
  publishReadiness?: CategoryDetail["publishReadiness"];
}

type CategoryInput = Omit<ApiBody<typeof putApiV1AdminCategoriesById>, "expectedRevision" | "status">;
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
    parentId: values.parentId,
    listingTemplate: values.listingTemplate,
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

export function CategoryForm({ defaultValues, isEdit = false, publishReadiness }: CategoryFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const t = useMessages(categoryFormMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { categories: categoryActions } = useCatalogActionPermissions();
  const canSave = isEdit ? categoryActions.canEdit : categoryActions.canCreate;
  const [selectedImage, setSelectedImage] = useState<MediaFile | null>(null);
  const translateItem = useTranslateMenuItem("category", isEdit ? defaultValues?.id : undefined);

  const form = useForm<CategoryFormInput, unknown, CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: "",
      status: "draft",
      slug: "",
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      image: null,
      parentId: null,
      listingTemplate: null,
      ...defaultValues,
      description: richTextOrNull(defaultValues?.description),
      content: richTextOrNull(defaultValues?.content),
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CategoryFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    // An empty address is made from the name on the server, with a number added if it is taken.
    createFn: (data) => apiData(postApiV1AdminCategories({
      body: { status: data.status, ...toCategoryInput(data), slug: data.slug || undefined },
    })),
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
      if (!isEdit && mutation.id) {
        void navigate({
          to: "/admin/categories/$categoryId/edit",
          params: { categoryId: mutation.id },
          replace: true,
        });
      }
    },
    onError: (error, message) => {
      if (readCategoryRevisionConflict(error)) throw new SaveConflict(t("conflict"));
      if (readAdminApiErrorCode(error) === "CATEGORY_PLACEMENT_REFUSED") {
        form.setError("parentId", { type: "server", message: t("placementRefused") });
        return t("placementRefused");
      }
      const address = message.includes("exists in trash")
        ? t("addressInTrash")
        : message.includes("slug already exists")
          ? t("addressTaken")
          : undefined;
      if (address) form.setError("slug", { type: "server", message: address });
      return address;
    },
  });

  const draft = form.watch();
  const saved = form.formState.defaultValues as CategoryFormInput;
  const shown = canSave ? draft : saved;
  const { name, slug, status, description } = shown;
  const errors = form.formState.errors;
  const committedStatus = defaultValues?.status ?? "draft";
  // An active category with no active products shows an empty page on the store.
  const staysEmpty = status === "published" && (publishReadiness?.eligibleProductCount ?? 0) === 0;

  return (
    <FormContainer
      presenceKey={isEdit && defaultValues?.id ? presenceKey("category", defaultValues.id) : null}
      heading={isEdit ? defaultValues?.name || t("category") : t("addCategory")}
      actions={isEdit && defaultValues?.id ? <AppActionsMenu target="category" id={defaultValues.id} extraItems={translateItem} /> : undefined}
      isSubmitting={isSubmitting}
      backUrl="/admin/categories"
      canSave={canSave}
      form={form}
      onSave={submitEntity}
      savedValues={(result) => {
        const saved = result as ApiResult<typeof putApiV1AdminCategoriesById> &
          Partial<ApiResult<typeof postApiV1AdminCategories>>;
        return { ...(saved.id ? { id: saved.id } : {}), revision: saved.revision, status: saved.status };
      }}
      reload={isEdit && defaultValues?.id ? async () => {
        const latest = await queryClient.fetchQuery({ ...categoryQueryOptions(defaultValues.id!), staleTime: 0 });
        const saved = form.formState.defaultValues as CategoryFormInput;
        rebaseForm(form, copyValues(saved), {
          ...saved,
          ...latest,
          // The saved image is shown as it was loaded; only a different image replaces it.
          image: latest.imageUrl === saved.image?.url ? saved.image : latest.imageUrl
            ? { id: `temp_${latest.id}`, url: latest.imageUrl, filename: latest.imageUrl.split("/").pop() || "", size: 0, createdAt: new Date() }
            : null,
        } as CategoryFormInput);
      } : undefined}
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
                render={({ field, fieldState }) => !canSave ? <ReadOnlyValue label={t("name")} value={saved.name} /> : (
                  <Field label={t("name")} error={fieldState.error?.message}>
                    <Input placeholder={t("namePlaceholder")} maxLength={100} {...field} />
                  </Field>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field, fieldState }) => !canSave ? <ReadOnlyValue label={t("description")} value={saved.description ? <RichContent content={saved.description} /> : null} /> : (
                  <Field label={t("description")} error={fieldState.error?.message}>
                    <DeferredTiptapEditor
                      content={field.value ?? ""}
                      onChange={(html) => field.onChange(richTextOrNull(html))}
                      placeholder={t("descriptionPlaceholder")}
                      ariaLabel={t("description")}
                      compact
                    />
                  </Field>
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
                render={({ field, fieldState }) => !canSave ? <ReadOnlyValue label={t("belowProducts")} value={saved.content ? <RichContent content={saved.content} /> : null} /> : (
                  <Field error={fieldState.error?.message}>
                    <DeferredTiptapEditor
                      content={field.value ?? ""}
                      onChange={(html) => field.onChange(richTextOrNull(html))}
                      placeholder={t("belowProductsPlaceholder")}
                      ariaLabel={t("belowProducts")}
                      compact
                    />
                  </Field>
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
                render={({ field, fieldState }) => (
                  <Field error={fieldState.error?.message}>
                    <FormImageUploadField
                      value={!canSave ? saved.image : selectedImage?.url === field.value?.url ? selectedImage : field.value}
                      readOnly={!canSave}
                      onChange={(file) => {
                        setSelectedImage(file);
                        const saved = form.formState.defaultValues?.image;
                        field.onChange(file && file.url === saved?.url ? saved : file);
                      }}
                      triggerLabel={t("chooseImage")}
                      changeTriggerLabel={t("changeImage")}
                      placeholder={t("noImage")}
                    />
                  </Field>
                )}
              />
            </CardContent>
          </Card>

          {isEdit && defaultValues?.id ? (
            <CategoryAttributeSetCard categoryId={defaultValues.id} canEdit={canSave} />
          ) : null}

          {isEdit && defaultValues?.id ? (
            <CustomFieldsCard ownerType="category" ownerId={defaultValues.id} canEdit={canSave} />
          ) : null}
          {isEdit && defaultValues?.id ? <AppResourceCards target="category" id={defaultValues.id} /> : null}

          <SearchListingCard
            resource="category"
            value={{
              title: shown.metaTitle ?? "",
              description: shown.metaDescription ?? "",
              handle: slug ?? "",
              hidden: shown.noIndex === true,
            }}
            autoHandle={!isEdit && !slug ? autoHandleFor(name ?? "", "category") : undefined}
            onChange={(next) => {
              if (next.title !== undefined) {
                form.setValue("metaTitle", next.title || null, { shouldDirty: true });
              }
              if (next.description !== undefined) {
                form.setValue("metaDescription", next.description || null, { shouldDirty: true });
              }
              if (next.handle !== undefined) {
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
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="status"
                render={({ field, fieldState }) => !canSave ? <ReadOnlyValue label={t("status")} value={t(saved.status === "published" ? "active" : saved.status === "internal" ? "hidden" : "draft")} /> : (
                  <Field
                    help={<>
                      {t(status === "published" ? "activeHelp" : status === "internal" ? "hiddenHelp" : "draftHelp")}
                      {staysEmpty ? <span className="block text-warning">{t("staysEmpty")}</span> : null}
                    </>}
                    error={fieldState.error?.message}
                  >
                    <SearchableSelect
                      value={field.value} onValueChange={field.onChange} disabled={!canSave} ariaLabel={t("status")}
                      triggerRef={field.ref}
                      onBlur={field.onBlur}
                      triggerClassName="w-full"
                      options={[{ value: "published", label: t("active") }, { value: "draft", label: t("draft") }, { value: "internal", label: t("hidden") }]}
                    />
                  </Field>
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
          <Card>
            <CardHeader>
              <CardTitle>{t("organization")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="parentId"
                render={({ field, fieldState }) => (
                  <ParentCategorySelect
                    selfId={defaultValues?.id}
                    name={name ?? ""}
                    value={canSave ? field.value ?? null : saved.parentId ?? null}
                    onChange={field.onChange}
                    readOnly={!canSave}
                    error={fieldState.error?.message}
                  />
                )}
              />
              <FormField
                control={form.control}
                name="listingTemplate"
                render={({ field }) => !canSave ? <TemplateSelect kind="listing" value={saved.listingTemplate ?? null} onChange={field.onChange} readOnly /> : (
                  <Field id="category-template" label={t("template")} help={t("templateHelp")}>
                    <TemplateSelect
                      id="category-template"
                      kind="listing"
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={!canSave}
                    />
                  </Field>
                )}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </FormContainer>
  );
}

/**
 * The category this one sits under, named by its path. Its own subtree and
 * places that would make a fifth level are left out (the server refuses them).
 */
function ParentCategorySelect({ selfId, name, value, onChange, readOnly, error }: {
  error?: string;
  selfId?: string;
  name: string;
  value: string | null;
  onChange: (value: string | null) => void;
  readOnly?: boolean;
}) {
  const t = useMessages(categoryFormMessages);
  const { data } = useQuery(categoryFormOptionsQueryOptions());
  const categories = data?.categories ?? [];
  const byId = indexCategories(categories);
  const options = parentChoices(selfId, categories).map((category) => ({
    value: category.id,
    label: categoryPathLabel(category.id, byId),
    keywords: [category.name],
    description: category.status === "published" ? undefined : t(category.status === "internal" ? "hidden" : "draft"),
  }));
  const parentPath = value ? categoryPathLabel(value, byId) : "";
  const ownName = name.trim() || t("thisCategory");
  if (readOnly) return <ReadOnlyValue label={t("parentCategory")} value={value ? parentPath || value : t("topLevel")} />;
  return (
    <Field
      id="category-parent"
      label={t("parentCategory")}
      help={t("path", { path: parentPath ? `${parentPath} › ${ownName}` : ownName })}
      error={error}
    >
      <SearchableSelect
        value={value ?? ""}
        options={options}
        selectedLabel={parentPath || undefined}
        clearable
        triggerClassName="w-full"
        placeholder={t("topLevel")}
        searchPlaceholder={t("searchCategories")}
        emptyMessage={t("noCategoriesFound")}
        onValueChange={(next) => onChange(next || null)}
      />
    </Field>
  );
}
