import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  CalendarClock,
  CircleDashed,
  ExternalLink,
  Globe2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { ResourceDiscoveryReadiness } from "@/components/admin/shared/ResourceDiscoveryReadiness";
import { CollapsibleCard } from "@/components/admin/product-form/CollapsibleCard";
import {
  createPage,
  updatePage,
  type PageIdPayload,
  type PageMutationPayload,
} from "@/lib/api-functions/pages";
import {
  pageFormSchema,
  type PageFormInput,
  type PageFormValues,
} from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  defaultPageScheduleDate,
  toDateTimeLocalValue,
  type PagePublicationMode,
} from "@/lib/page-publication";
import {
  toCreatePageInput,
  toUpdatePageInput,
} from "@/lib/page-form-input";

interface PageFormProps {
  defaultValues?: Partial<PageFormValues>;
  isEdit?: boolean;
  contentType?: "page" | "article";
}

function ArticleTagsInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [draft, setDraft] = React.useState(() => value.join(", "));

  return (
    <Input
      placeholder="Guides, footwear"
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
      className="min-h-11 sm:min-h-9"
    />
  );
}

export function PageForm({
  defaultValues,
  isEdit = false,
  contentType = "page",
}: PageFormProps) {
  const navigate = useNavigate();
  const [isClient, setIsClient] = React.useState(false);
  const { getStorefrontPath } = useStorefrontUrl();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.PAGES_CREATE);
  const canPublish = hasPermission(PERMISSIONS.PAGES_PUBLISH);
  const canSave = isEdit ? hasPermission(PERMISSIONS.PAGES_EDIT) : canCreate;

  React.useEffect(() => {
    setIsClient(true);
  }, []);

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

  const { isSubmitting, handleSubmit: submitEntity } =
    useEntityFormSubmit<PageFormValues>({
      entityName: contentType === "article" ? "Article" : "Page",
      isEdit,
      entityId: defaultValues?.id,
      createFn: (data) => createPage({ data: toCreatePageInput(data) }),
      updateFn: (data) => {
        if (
          !data.revision ||
          !Number.isInteger(data.revision) ||
          data.revision < 1
        ) {
          throw new Error(
            `${contentType === "article" ? "Article" : "Page"} revision is missing. Reload before saving.`,
          );
        }
        return updatePage({
          data: {
            id: data.id,
            expectedRevision: data.revision,
            ...toUpdatePageInput(data),
          },
        });
      },
      invalidateKeys: [
        queryKeys.pages.list(),
        ...(isEdit && defaultValues?.id
          ? [queryKeys.pages.detail(defaultValues.id)]
          : []),
      ],
      navigateTo:
        contentType === "article" ? "/admin/articles" : "/admin/pages",
      onSuccess: (result) => {
        const mutation = result as PageMutationPayload & Partial<PageIdPayload>;
        const id = mutation.id || defaultValues?.id;
        form.reset({
          ...form.getValues(),
          ...(id ? { id } : {}),
          revision: mutation.revision,
        });
        const entity = contentType === "article" ? "Article" : "Page";
        toast.success(isEdit ? `${entity} saved` : `${entity} created`);
        if (!isEdit && mutation.id) {
          if (contentType === "article") {
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
    });

  const handleSubmit = (values: PageFormValues) => {
    submitEntity(values);
  };

  // Auto-generate slug from title (only when creating a new page, not editing)
  React.useEffect(() => {
    if (!isClient || isEdit) return;

    const subscription = form.watch((value, { name }) => {
      if (name === "title" && value.title) {
        const slug = value.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        form.setValue("slug", slug, {
          shouldValidate: true,
        });
      }
    });
    return () => subscription.unsubscribe();
  }, [form, isClient, isEdit]);

  const publicationMode = form.watch("publicationMode");
  const committedSlug = defaultValues?.slug;
  const publicPath = committedSlug
    ? contentType === "article"
      ? `/blog/${committedSlug}`
      : `/${committedSlug}`
    : contentType === "article"
      ? "/blog"
      : "/";
  const committedStorefrontPageUrl = getStorefrontPath(publicPath);
  const isCommittedLivePage =
    isEdit &&
    Boolean(committedSlug) &&
    defaultValues?.publicationMode === "published";

  const changePublicationMode = React.useCallback(
    (mode: PagePublicationMode) => {
      form.setValue("publicationMode", mode, {
        shouldDirty: true,
        shouldValidate: true,
      });
      if (mode === "draft" || mode === "published") {
        form.setValue("publishedAt", null, {
          shouldDirty: true,
          shouldValidate: true,
        });
        return;
      }
      const current = form.getValues("publishedAt");
      form.setValue(
        "publishedAt",
        current && current.getTime() > Date.now()
          ? current
          : defaultPageScheduleDate(),
        { shouldDirty: true, shouldValidate: true },
      );
    },
    [form],
  );

  return (
    <FormContainer
      title={contentType === "article" ? "Articles" : "Pages"}
      entityName={form.watch("title")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl={contentType === "article" ? "/admin/articles" : "/admin/pages"}
      newUrl={
        contentType === "article" ? "/admin/articles/new" : "/admin/pages/new"
      }
      newLabel={contentType === "article" ? "New article" : "New page"}
      canCreateNew={canCreate}
      canSave={canSave}
      saveDisabledReason={
        isEdit
          ? "You do not have permission to edit pages."
          : "You do not have permission to create pages."
      }
      saveLabel={
        isEdit
          ? `Save ${contentType}`
          : `Create ${contentType}`
      }
      form={form}
      onSubmit={form.handleSubmit(handleSubmit)}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Title field (standalone) */}
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">
                  Title <span className="text-destructive">*</span>
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      contentType === "article" ? "Article title" : "Page title"
                    }
                    {...field}
                    className="min-h-11 text-base sm:min-h-9"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Page Content card */}
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-base">Content</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <DeferredTiptapEditor
                        content={field.value}
                        onChange={field.onChange}
                        placeholder={
                          contentType === "article"
                            ? "Write your article…"
                            : "Write your page content…"
                        }
                        ariaLabel={
                          contentType === "article"
                            ? "Article content"
                            : "Page content"
                        }
                        compact={true}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {contentType === "article" ? (
            <Card>
              <CardHeader className="px-4 pb-3 pt-4">
                <CardTitle className="text-base">Excerpt</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <FormField
                  control={form.control}
                  name="excerpt"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder="Short summary for the blog and search results"
                          value={field.value ?? ""}
                          onChange={(event) =>
                            field.onChange(event.target.value || null)
                          }
                        />
                      </FormControl>
                      <CharacterCounter
                        current={field.value?.length ?? 0}
                        recommended={500}
                        max={500}
                      />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>
          ) : null}

          {/* Featured Image Card (collapsible) */}
          <CollapsibleCard title="Featured image" defaultOpen={true}>
            <FormField
              control={form.control}
              name="featuredImage"
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
              <CardTitle className="text-sm">Visibility</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 border-t px-4 py-3">
              <FormField
                control={form.control}
                name="publicationMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="sr-only">Visibility</FormLabel>
                    <Select
                      value={field.value}
                      disabled={!canPublish}
                      onValueChange={(value) =>
                        changePublicationMode(value as PagePublicationMode)
                      }
                    >
                      <FormControl>
                        <SelectTrigger
                          aria-label={`${contentType === "article" ? "Article" : "Page"} visibility`}
                          className="min-h-11 sm:min-h-9"
                        >
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="draft">
                          <span className="flex items-center gap-2">
                            <CircleDashed className="h-3.5 w-3.5" /> Draft
                          </span>
                        </SelectItem>
                        <SelectItem value="published">
                          <span className="flex items-center gap-2">
                            <Globe2 className="h-3.5 w-3.5" /> Publish now
                          </span>
                        </SelectItem>
                        <SelectItem value="scheduled">
                          <span className="flex items-center gap-2">
                            <CalendarClock className="h-3.5 w-3.5" /> Schedule
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {!canPublish ? (
                      <FormDescription className="text-xs">
                        Publish permission is required to change visibility.
                      </FormDescription>
                    ) : null}
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
                      <FormLabel className="text-xs">
                        Publication time
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="datetime-local"
                          className="min-h-11 sm:min-h-9"
                          value={toDateTimeLocalValue(field.value)}
                          min={toDateTimeLocalValue(new Date())}
                          onChange={(event) =>
                            field.onChange(
                              event.target.value
                                ? new Date(event.target.value)
                                : null,
                            )
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {publicationMode === "published" ? (
                  <>
                    <Globe2 className="h-3.5 w-3.5 text-emerald-600" /> Visible
                    on the storefront.
                  </>
                ) : publicationMode === "scheduled" ? (
                  <>
                    <CalendarClock className="h-3.5 w-3.5 text-sky-600" />{" "}
                    Hidden until the scheduled time.
                  </>
                ) : (
                  <>
                    <CircleDashed className="h-3.5 w-3.5" /> Hidden from the
                    storefront.
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-4 py-3">
              <CardTitle className="text-sm">
                {contentType === "article" ? "Organization" : "Page"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 border-t px-4 py-3">
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">URL</FormLabel>
                    <div className="flex items-center rounded-md border border-input bg-background shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                      <span className="pl-3 text-sm text-muted-foreground">
                        {contentType === "article" ? "/blog/" : "/"}
                      </span>
                      <FormControl>
                        <Input
                          placeholder={
                            contentType === "article"
                              ? "article-url"
                              : "page-url"
                          }
                          {...field}
                          className="min-h-11 border-0 pl-0 shadow-none focus-visible:ring-0 sm:min-h-9"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isCommittedLivePage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-full gap-2 sm:min-h-9"
                  asChild
                >
                  <a
                    href={committedStorefrontPageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View live
                  </a>
                </Button>
              ) : null}

              {contentType === "article" ? (
                <>
                  <FormField
                    control={form.control}
                    name="author"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Author</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Author name"
                            value={field.value ?? ""}
                            onChange={(event) =>
                              field.onChange(event.target.value || null)
                            }
                            className="min-h-11 sm:min-h-9"
                          />
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
                        <FormLabel className="text-xs">Tags</FormLabel>
                        <FormControl>
                          <ArticleTagsInput
                            value={field.value}
                            onChange={field.onChange}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          Separate tags with commas.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              ) : null}

              <div className="divide-y rounded-md border">
                {contentType === "page" ? (
                  <FormField
                    control={form.control}
                    name="hideTitle"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between px-3 py-2.5">
                        <FormLabel className="text-sm font-normal">
                          Hide page title
                        </FormLabel>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                ) : null}
                <FormField
                  control={form.control}
                  name="hideHeader"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between px-3 py-2.5">
                      <FormLabel className="text-sm font-normal">
                        Hide header
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hideFooter"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between px-3 py-2.5">
                      <FormLabel className="text-sm font-normal">
                        Hide footer
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          {/* SEO card (collapsible) */}
          <CollapsibleCard title="Search listing" defaultOpen={false}>
            <FormField
              control={form.control}
              name="metaTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meta title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="SEO title (optional)"
                      className="min-h-11 sm:min-h-9"
                      {...field}
                      value={field.value || ""}
                      onChange={(e) => {
                        field.onChange(e.target.value || null);
                      }}
                    />
                  </FormControl>
                  {field.value && (
                    <CharacterCounter
                      current={field.value.length}
                      recommended={60}
                      max={70}
                    />
                  )}
                  <FormDescription>Defaults to the content title.</FormDescription>
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
                      placeholder="SEO description (optional)"
                      {...field}
                      value={field.value || ""}
                      rows={3}
                      onChange={(e) => {
                        field.onChange(e.target.value || null);
                      }}
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
                      placeholder={
                        contentType === "article"
                          ? "/blog/article-url"
                          : "/about-us"
                      }
                      className="min-h-11 sm:min-h-9"
                      {...field}
                      value={field.value || ""}
                      onChange={(event) => {
                        field.onChange(event.target.value || null);
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Leave blank to use this URL.
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
                        Keep it public, but ask search engines not to index it.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
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
                        Keep it public, but remove it from sitemap XML.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <ResourceDiscoveryReadiness
              kind={contentType}
              slug={form.watch("slug")}
              canonicalPath={form.watch("canonicalPath")}
              noIndex={form.watch("noIndex")}
              excludeFromSitemap={form.watch("excludeFromSitemap")}
              isPublished={form.watch("publicationMode") === "published"}
            />
          </CollapsibleCard>
        </div>
      </div>
    </FormContainer>
  );
}
