import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { toHandle } from "@scalius/shared/handle";
import { postApiV1AdminBrands, putApiV1AdminBrandsById } from "@scalius/api-client/sdk";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { RichContent } from "../ui/rich-content";
import { NativeSelect } from "../ui/native-select";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { SaveConflict } from "@/components/admin/shared/SaveBar";
import { copyValues, rebaseForm } from "@/components/admin/shared/use-form-save-bar";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { SearchListingCard } from "@/components/admin/search-listing/SearchListingCard";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { apiData, type ApiResult } from "@/lib/api";
import { brandQueryOptions, type BrandDetail } from "@/lib/api-query-options/brands";
import { brandFormSchema, type BrandFormInput, type BrandFormValues } from "@/lib/brand-form-schema";
import { getPlainText } from "@/lib/format-utils";
import { queryKeys } from "@/lib/query-keys";
import { readAdminApiErrorCode } from "@/lib/admin-api-error";
import { useMessages } from "~/i18n";
import { brandMessages } from "~/i18n/brands";

/** The saved brand as editor values (the logo as the file picker's value). */
export function brandFormValues(brand: BrandDetail): BrandFormInput {
  return {
    id: brand.id,
    revision: brand.revision,
    status: brand.status,
    name: brand.name,
    description: brand.description,
    slug: brand.slug,
    logo: brand.logo
      ? {
          id: brand.logo.mediaId,
          url: brand.logo.url,
          filename: brand.logo.url.split("/").pop() || "",
          size: 0,
          altText: brand.logo.alt,
          width: brand.logo.width,
          height: brand.logo.height,
          createdAt: new Date(0),
        }
      : null,
    sortOrder: brand.sortOrder,
    metaTitle: brand.metaTitle,
    metaDescription: brand.metaDescription,
    canonicalPath: brand.canonicalPath,
    noIndex: brand.noIndex,
    excludeFromSitemap: brand.excludeFromSitemap,
  };
}

function toBrandInput(values: BrandFormValues) {
  return {
    name: values.name,
    description: values.description,
    logoMediaId: values.logo?.id ?? null,
    sortOrder: values.sortOrder,
    metaTitle: values.metaTitle,
    metaDescription: values.metaDescription,
    canonicalPath: values.canonicalPath,
    noIndex: values.noIndex,
    excludeFromSitemap: values.excludeFromSitemap,
    status: values.status,
  };
}

/** Shopify's resource editor for a brand: name, story, logo, search listing; status on the side. */
export function BrandForm({ defaultValues }: { defaultValues?: BrandFormInput }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const t = useMessages(brandMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  // Brands share the category permissions (API route permissions).
  const { categories: can } = useCatalogActionPermissions();
  const isEdit = Boolean(defaultValues?.id);
  const canSave = isEdit ? can.canEdit : can.canCreate;

  const form = useForm<BrandFormInput, unknown, BrandFormValues>({
    resolver: zodResolver(brandFormSchema),
    defaultValues: {
      status: "draft",
      name: "",
      description: null,
      slug: "",
      logo: null,
      sortOrder: 0,
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit } = useEntityFormSubmit<BrandFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    // An empty address is made from the name on the server, with a number added if it is taken.
    createFn: (data) => apiData(postApiV1AdminBrands({ body: { ...toBrandInput(data), slug: data.slug || undefined } })),
    updateFn: (data) => {
      if (!data.revision) throw new Error(t("reloadToSave"));
      return apiData(putApiV1AdminBrandsById({
        path: { id: data.id },
        body: { ...toBrandInput(data), slug: data.slug, expectedRevision: data.revision },
      }));
    },
    invalidateKeys: [
      queryKeys.brands.list(),
      queryKeys.brands.formOptions(),
      ...(defaultValues?.id ? [queryKeys.brands.detail(defaultValues.id)] : []),
    ],
    onSuccess: (result) => {
      const saved = result as Partial<ApiResult<typeof postApiV1AdminBrands>>;
      if (!isEdit && saved.id) {
        void navigate({ to: "/admin/brands/$brandId/edit", params: { brandId: saved.id }, replace: true });
      }
    },
    onError: (error, message) => {
      if (readAdminApiErrorCode(error) === "BRAND_REVISION_CONFLICT") throw new SaveConflict(t("conflict"));
      if (message.includes("slug already exists")) {
        form.setError("slug", { type: "server", message: t("addressTaken") });
        return t("addressTaken");
      }
      return undefined;
    },
  });

  const name = form.watch("name");
  const slug = form.watch("slug");
  const status = form.watch("status");
  const description = form.watch("description");
  const errors = form.formState.errors;
  const committed = defaultValues?.status === "published" && defaultValues.slug;

  return (
    <FormContainer
      heading={isEdit ? defaultValues?.name || t("brand") : t("addBrand")}
      isSubmitting={isSubmitting}
      backUrl="/admin/brands"
      canSave={canSave}
      form={form}
      onSave={handleSubmit}
      savedValues={(result) => {
        const saved = result as Partial<ApiResult<typeof postApiV1AdminBrands>>;
        return { ...(saved.id ? { id: saved.id } : {}), ...(saved.slug ? { slug: saved.slug } : {}), revision: saved.revision, status: saved.status };
      }}
      reload={defaultValues?.id ? async () => {
        const latest = await queryClient.fetchQuery({ ...brandQueryOptions(defaultValues.id!), staleTime: 0 });
        const saved = form.formState.defaultValues as BrandFormInput;
        rebaseForm(form, copyValues(saved), brandFormValues(latest));
      } : undefined}
      unsavedLabel={isEdit ? undefined : t("unsaved")}
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
                      <Input placeholder={t("namePlaceholder")} maxLength={120} {...field} />
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
              <CardTitle>{t("logo")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="logo"
                render={({ field }) => (
                  <FormItem>
                    <FormImageUploadField
                      value={field.value as never}
                      onChange={field.onChange}
                      aspectRatio="aspect-[3/2]"
                      triggerLabel={t("chooseLogo")}
                      changeTriggerLabel={t("changeLogo")}
                      placeholder={t("noLogo")}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <SearchListingCard
            resource="brand"
            value={{
              title: form.watch("metaTitle") ?? "",
              description: form.watch("metaDescription") ?? "",
              handle: slug ?? "",
              hidden: form.watch("noIndex") === true,
            }}
            autoHandle={!isEdit && !slug && name?.trim() ? toHandle(name) || "brand" : undefined}
            onChange={(next) => {
              if (next.title !== undefined) form.setValue("metaTitle", next.title || null, { shouldDirty: true });
              if (next.description !== undefined) form.setValue("metaDescription", next.description || null, { shouldDirty: true });
              if (next.handle !== undefined) {
                form.setValue("slug", next.handle, { shouldDirty: true, shouldValidate: true });
                // A saved main address must follow the brand's own address.
                if (form.getValues("canonicalPath") !== null) {
                  form.setValue("canonicalPath", `/brands/${next.handle}`, { shouldDirty: true });
                }
              }
              if (next.hidden !== undefined) form.setValue("noIndex", next.hidden, { shouldDirty: true });
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
                      </NativeSelect>
                    </FormControl>
                    <FormDescription>{t(status === "published" ? "activeHelp" : "draftHelp")}</FormDescription>
                  </FormItem>
                )}
              />
              {committed ? (
                <Button type="button" variant="outline" asChild>
                  <a href={getStorefrontPath(`/brands/${defaultValues?.slug}`)} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    {t("viewOnStore")}
                  </a>
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("sortOrder")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="sortOrder"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        step={1}
                        aria-label={t("sortOrder")}
                        value={Number.isFinite(field.value) ? field.value : 0}
                        onChange={(event) => field.onChange(event.target.value === "" ? 0 : Math.trunc(Number(event.target.value)))}
                        onBlur={field.onBlur}
                      />
                    </FormControl>
                    <FormDescription>{t("sortOrderHelp")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </FormContainer>
  );
}
