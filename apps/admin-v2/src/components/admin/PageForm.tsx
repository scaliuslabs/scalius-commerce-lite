import React, { Suspense } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
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
import { Switch } from "../ui/switch";
import { ExternalLink } from "lucide-react";

const TiptapEditor = React.lazy(() =>
  import("../ui/tiptap").then((m) => ({ default: m.TiptapEditor }))
);
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { FormImageUploadField } from "@/components/admin/shared/FormImageUploadField";
import { CollapsibleCard } from "@/components/admin/product-form/CollapsibleCard";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "@/lib/api-helpers";
import { createPage, updatePage } from "@/lib/api.functions";
import { LoadingFallback } from "./shared/LoadingFallback";
import { pageFormSchema, type PageFormValues } from "@/lib/form-schemas";

interface PageFormProps {
  defaultValues?: Partial<PageFormValues>;
  isEdit?: boolean;
}

export function PageForm({ defaultValues, isEdit = false }: PageFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isClient, setIsClient] = React.useState(false);
  const { getStorefrontPath } = useStorefrontUrl();

  React.useEffect(() => {
    setIsClient(true);
  }, []);

  const form = useForm<PageFormValues>({
    resolver: zodResolver(pageFormSchema),
    defaultValues: {
      title: "",
      slug: "",
      content: "",
      metaTitle: null,
      metaDescription: null,
      isPublished: true,
      publishedAt: null,
      sortOrder: 0,
      hideHeader: false,
      hideFooter: false,
      hideTitle: false,
      featuredImage: null,
      ...defaultValues,
    },
  });

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const handleSubmit: SubmitHandler<PageFormValues> = async (values) => {
    try {
      setIsSubmitting(true);

      // Set publishedAt to current date if isPublished is true and publishedAt is not set
      if (values.isPublished && !values.publishedAt) {
        values.publishedAt = new Date();
      }

      if (isEdit) {
        const entityId = defaultValues?.id || values.id;
        if (!entityId) throw new Error("Page ID is required for update");
        await updatePage({ data: { ...values, id: entityId } as Record<string, unknown> & { id: string } });
        queryClient.invalidateQueries({ queryKey: ["pages", "detail", entityId] });
      } else {
        await createPage({ data: values as unknown as Record<string, unknown> });
      }

      // Invalidate queries so list page shows fresh data
      queryClient.invalidateQueries({ queryKey: ["pages", "list"] });

      toast.success(
        isEdit ? "Page updated successfully!" : "Page created successfully!",
        {
          description: `"${values.title}" has been ${isEdit ? "updated" : "created"}.`,
        },
      );

      // Small delay to show toast before redirect
      setTimeout(() => {
        void navigate({ to: "/admin/pages" });
      }, 500);
    } catch (error: unknown) {
      console.error("Error submitting form:", error);
      toast.error("Failed to save page", {
        description: (error instanceof Error ? error.message : String(error)) || "Please try again.",
        duration: 6000,
      });
    } finally {
      setIsSubmitting(false);
    }
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

  const slug = form.watch("slug");
  const storefrontPageUrl = getStorefrontPath(slug ? `/${slug}` : "/");

  return (
    <FormContainer
      title="Pages"
      entityName={form.watch("title")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl="/admin/pages"
      newUrl="/admin/pages/new"
      newLabel="New Page"
      saveLabel={isEdit ? "Save Page" : "Create Page"}
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
                  <Input placeholder="Page title" {...field} className="text-base" />
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
                      {isClient && (
                        <Suspense fallback={<LoadingFallback height="h-64" />}>
                          <TiptapEditor
                            content={field.value}
                            onChange={field.onChange}
                            placeholder="Write your page content here..."
                            compact={true}
                          />
                        </Suspense>
                      )}
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Featured Image Card (collapsible) */}
          <CollapsibleCard
            title="Featured Image"
            description="Add a featured image for this page (optional)"
            defaultOpen={true}
          >
            <FormField
              control={form.control}
              name="featuredImage"
              render={({ field }) => (
                <FormItem>
                  <FormImageUploadField
                    value={field.value}
                    onChange={field.onChange}
                    triggerLabel="Select Featured Image"
                    changeTriggerLabel="Change Featured Image"
                    placeholder="No featured image selected"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
          </CollapsibleCard>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-3">
          {/* Status & Display card */}
            <Card>
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-base">Status & Display</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <FormField
                  control={form.control}
                  name="isPublished"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium">
                          Published Status
                        </FormLabel>
                        <FormDescription>
                          Page will be visible on the site
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
                  name="hideHeader"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium">Hide Header</FormLabel>
                        <FormDescription>
                          Hide the main site header on this page
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
                  name="hideFooter"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium">Hide Footer</FormLabel>
                        <FormDescription>
                          Hide the main site footer on this page
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
                  name="hideTitle"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm font-medium">Hide Page Title</FormLabel>
                        <FormDescription>
                          Hide the page title from the content area
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
              </CardContent>
            </Card>

            {/* URL & Settings card */}
            <Card>
              <CardHeader className="pb-3 pt-4 px-4">
                <CardTitle className="text-base">URL & Settings</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <FormField
                  control={form.control}
                  name="slug"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Slug</FormLabel>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground whitespace-nowrap">/</span>
                        <FormControl>
                          <Input placeholder="page-url-slug" {...field} className="h-9" />
                        </FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="sortOrder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sort Order</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="0"
                          {...field}
                          className="h-9"
                          onChange={(e) => {
                            const value = e.target.value;
                            field.onChange(value === "" ? 0 : parseInt(value, 10));
                          }}
                        />
                      </FormControl>
                      <FormDescription>
                        Lower values appear first in navigation.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {isEdit && slug && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 text-sm font-medium"
                    asChild
                  >
                    <a
                      href={storefrontPageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View on Storefront
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* SEO card (collapsible) */}
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
                        placeholder="SEO title (optional)"
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
                    <FormDescription>
                      Leave empty to use the page title. Recommended: 50-60
                      characters.
                    </FormDescription>
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
                    <FormDescription>
                      A brief description of the page for search engines.
                      Recommended: 150-160 characters.
                    </FormDescription>
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
