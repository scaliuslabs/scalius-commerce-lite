import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { RichContent } from "../ui/rich-content";
import { SearchableSelect } from "../ui/searchable-select";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { SaveConflict } from "@/components/admin/shared/SaveBar";
import { copyValues, rebaseForm } from "@/components/admin/shared/use-form-save-bar";
import { pageQueryOptions } from "@/lib/api-query-options/pages";
import { toPageFormValues } from "@/lib/page-form-values";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { SearchListingCard, autoHandleFor } from "@/components/admin/search-listing/SearchListingCard";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { postApiV1AdminPages, putApiV1AdminPagesById } from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "@/lib/api";
import { AdminApiResponseError } from "@/lib/admin-api-error";
import { pageFormSchema, type PageFormInput, type PageFormValues } from "@/lib/form-schemas";
import { getPlainText } from "@/lib/format-utils";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { useMessages } from "~/i18n";
import { pageFormMessages } from "~/i18n/page-form";
import { defaultPageScheduleDate, toDateTimeLocalValue, type PagePublicationMode } from "@/lib/page-publication";
import { toCreatePageInput, toUpdatePageInput } from "@/lib/page-form-input";

interface PageFormProps {
  defaultValues?: Partial<PageFormValues>;
  isEdit?: boolean;
  /** Where the back arrow goes instead of the list (a page opened from Settings → Policies). */
  backUrl?: string;
  contentType?: "page" | "article";
}

function ArticleTagsInput({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const t = useMessages(pageFormMessages);
  const [draft, setDraft] = useState(() => value.join(", "));

  return (
    <Input
      placeholder={t("tagsPlaceholder")}
      value={draft}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        const seen = new Set<string>();
        onChange(
          nextDraft
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => {
              const normalized = tag.toLocaleLowerCase("en-US");
              if (!tag || seen.has(normalized)) return false;
              seen.add(normalized);
              return true;
            }),
        );
      }}
    />
  );
}

export function PageForm({ defaultValues, isEdit = false, contentType = "page", backUrl }: PageFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const t = useMessages(pageFormMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.PAGES_CREATE);
  const canPublish = hasPermission(PERMISSIONS.PAGES_PUBLISH);
  const canSave = isEdit ? hasPermission(PERMISSIONS.PAGES_EDIT) : canCreate;
  const isArticle = contentType === "article";
  const pathFor = (slug: string) => (isArticle ? `/blog/${slug}` : `/${slug}`);

  const form = useForm<PageFormInput, unknown, PageFormValues>({
    resolver: zodResolver(pageFormSchema),
    defaultValues: {
      contentType,
      title: "",
      slug: "",
      content: "",
      excerpt: null,
      author: null,
      tags: [],
      metaTitle: null,
      metaDescription: null,
      canonicalPath: null,
      noIndex: false,
      excludeFromSitemap: false,
      publicationMode: "draft",
      publishedAt: null,
      hideHeader: false,
      hideFooter: false,
      hideTitle: false,
      featuredImage: null,
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<PageFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => apiData(postApiV1AdminPages({ body: toCreatePageInput(data) })),
    updateFn: (data) => {
      if (!data.revision || !Number.isInteger(data.revision) || data.revision < 1) {
        throw new Error(t("reloadToSave"));
      }
      return apiData(putApiV1AdminPagesById({
        path: { id: data.id },
        body: { expectedRevision: data.revision, ...toUpdatePageInput(data) },
      }));
    },
    invalidateKeys: [
      queryKeys.pages.list(),
      ...(isEdit && defaultValues?.id ? [queryKeys.pages.detail(defaultValues.id)] : []),
    ],
    onSuccess: (result) => {
      const mutation = result as ApiResult<typeof putApiV1AdminPagesById> &
        Partial<ApiResult<typeof postApiV1AdminPages>>;
      if (!isEdit && mutation.id) {
        if (isArticle) {
          void navigate({
            to: "/admin/articles/$articleId/edit",
            params: { articleId: mutation.id },
            replace: true,
          });
        } else {
          void navigate({
            to: "/admin/pages/$pageId/edit",
            params: { pageId: mutation.id },
            replace: true,
          });
        }
      }
    },
    onError: (error, message) => {
      if (error instanceof AdminApiResponseError && error.code === "PAGE_REVISION_CONFLICT") throw new SaveConflict(t("conflict"));
      if (!message.includes("slug already exists")) return undefined;
      form.setError("slug", { type: "server", message: t("addressTaken") });
      return t("addressTaken");
    },
  });

  const changePublicationMode = useCallback(
    (mode: PagePublicationMode) => {
      form.setValue("publicationMode", mode, { shouldDirty: true, shouldValidate: true });
      if (mode === "draft" || mode === "published") {
        form.setValue("publishedAt", null, { shouldDirty: true, shouldValidate: true });
        return;
      }
      const current = form.getValues("publishedAt");
      form.setValue(
        "publishedAt",
        current && current.getTime() > Date.now() ? current : defaultPageScheduleDate(),
        { shouldDirty: true, shouldValidate: true },
      );
    },
    [form],
  );

  const title = form.watch("title");
  const slug = form.watch("slug");
  const content = form.watch("content");
  const excerpt = form.watch("excerpt");
  const publicationMode = form.watch("publicationMode");
  const errors = form.formState.errors;
  const committedSlug = defaultValues?.slug;
  const isCommittedLivePage = isEdit && Boolean(committedSlug) && defaultValues?.publicationMode === "published";

  return (
    <FormContainer
      heading={isEdit ? defaultValues?.title || t(isArticle ? "blogPost" : "page") : t(isArticle ? "addBlogPost" : "addPage")}
      unsavedLabel={isEdit ? undefined : t(isArticle ? "unsavedBlogPost" : "unsavedPage")}
      savedMessage={t(isEdit ? (isArticle ? "blogPostSaved" : "pageSaved") : isArticle ? "blogPostCreated" : "pageCreated")}
      isSubmitting={isSubmitting}
      backUrl={backUrl ?? (isArticle ? "/admin/articles" : "/admin/pages")}
      canSave={canSave}
      form={form}
      onSave={submitEntity}
      savedValues={(result) => {
        const saved = result as ApiResult<typeof putApiV1AdminPagesById> &
          Partial<ApiResult<typeof postApiV1AdminPages>>;
        return { ...(saved.id ? { id: saved.id } : {}), revision: saved.revision };
      }}
      reload={isEdit && defaultValues?.id ? async () => {
        const latest = await queryClient.fetchQuery({ ...pageQueryOptions(defaultValues.id!), staleTime: 0 });
        rebaseForm(form, copyValues(form.formState.defaultValues as PageFormInput), toPageFormValues(latest) as PageFormInput);
      } : undefined}
    >
      {/* FormContainer shows the read-only notice and disables the fields when saving isn't allowed. */}
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardContent className="space-y-4 pt-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("title")}</FormLabel>
                    <FormControl>
                      <Input placeholder={t(isArticle ? "titlePlaceholder_article" : "titlePlaceholder_page")} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("content")}</FormLabel>
                    {canSave ? (
                      <DeferredTiptapEditor
                        content={field.value}
                        onChange={field.onChange}
                        placeholder={t(isArticle ? "contentPlaceholder_article" : "contentPlaceholder_page")}
                        ariaLabel={t("content")}
                        compact
                      />
                    ) : (
                      <RichContent content={field.value} />
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              {isArticle ? (
                <FormField
                  control={form.control}
                  name="excerpt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("excerpt")}</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          maxLength={500}
                          value={field.value ?? ""}
                          onChange={(event) => field.onChange(event.target.value || null)}
                        />
                      </FormControl>
                      <FormDescription>{t("excerptHelp")}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("image")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="featuredImage"
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
            resource={isArticle ? "blogPost" : "page"}
            value={{
              title: form.watch("metaTitle") ?? "",
              description: form.watch("metaDescription") ?? "",
              handle: slug ?? "",
              hidden: form.watch("noIndex") === true,
            }}
            autoHandle={!isEdit && !slug ? autoHandleFor(title ?? "", isArticle ? "post" : "page") : undefined}
            onChange={(next) => {
              if (next.title !== undefined) {
                form.setValue("metaTitle", next.title || null, { shouldDirty: true });
              }
              if (next.description !== undefined) {
                form.setValue("metaDescription", next.description || null, { shouldDirty: true });
              }
              if (next.handle !== undefined) {
                // A main address that pointed at this page's old address follows it.
                if (form.getValues("canonicalPath") === pathFor(form.getValues("slug"))) {
                  form.setValue("canonicalPath", pathFor(next.handle), { shouldDirty: true });
                }
                form.setValue("slug", next.handle, { shouldDirty: true, shouldValidate: true });
              }
              if (next.hidden !== undefined) {
                form.setValue("noIndex", next.hidden, { shouldDirty: true });
              }
            }}
            fallbackTitle={title ?? ""}
            fallbackDescription={(isArticle && excerpt) || getPlainText(content ?? null, 320)}
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
              <CardTitle>{t("visibility")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <FormField
                control={form.control}
                name="publicationMode"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <SearchableSelect
                        triggerRef={field.ref}
                        onBlur={field.onBlur}
                        value={field.value}
                        disabled={!canPublish}
                        onValueChange={(value) => changePublicationMode(value as PagePublicationMode)}
                        ariaLabel={t("visibility")}
                        triggerClassName="w-full"
                        options={[{ value: "draft", label: t("draft") }, { value: "published", label: t("visible") }, { value: "scheduled", label: t("scheduled") }]}
                      />
                    </FormControl>
                    <FormDescription>
                      {!canPublish
                        ? t("publishPermission")
                        : t(field.value === "published" ? "visibleHelp" : field.value === "scheduled" ? "scheduledHelp" : "draftHelp")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {publicationMode === "scheduled" ? (
                <FormField
                  control={form.control}
                  name="publishedAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("publishAt")}</FormLabel>
                      <FormControl>
                        <Input
                          type="datetime-local"
                          disabled={!canPublish}
                          value={toDateTimeLocalValue(field.value)}
                          min={toDateTimeLocalValue(new Date())}
                          onChange={(event) => field.onChange(event.target.value ? new Date(event.target.value) : null)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              {isCommittedLivePage && committedSlug ? (
                <Button type="button" variant="outline" asChild>
                  <a href={getStorefrontPath(pathFor(committedSlug))} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    {t("viewOnStore")}
                  </a>
                </Button>
              ) : null}
            </CardContent>
          </Card>

          {isArticle ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("organization")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="author"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("author")}</FormLabel>
                      <FormControl>
                        <Input value={field.value ?? ""} onChange={(event) => field.onChange(event.target.value || null)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tags"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("tags")}</FormLabel>
                      <FormControl>
                        <ArticleTagsInput value={field.value} onChange={field.onChange} />
                      </FormControl>
                      <FormDescription>{t("tagsHelp")}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t("layout")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(isArticle ? (["hideHeader", "hideFooter"] as const) : (["hideTitle", "hideHeader", "hideFooter"] as const)).map(
                (name) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between gap-3">
                          <FormLabel>{t(name)}</FormLabel>
                          <FormControl>
                            <Switch checked={field.value} onCheckedChange={field.onChange} />
                          </FormControl>
                        </div>
                      </FormItem>
                    )}
                  />
                ),
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </FormContainer>
  );
}
