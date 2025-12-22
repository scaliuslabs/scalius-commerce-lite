import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import {
  Form,
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
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Loader2, ExternalLink, Save } from "lucide-react";
import { TiptapEditor } from "../ui/tiptap-editor";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";

const pageFormSchema = z.object({
  id: z.string().optional(),
  title: z
    .string()
    .min(3, "Page title must be at least 3 characters")
    .max(100, "Page title must be less than 100 characters"),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  content: z.string().min(1, "Content is required"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  isPublished: z.boolean(),
  publishedAt: z.date().nullable().optional(),
  sortOrder: z.number(),
  hideHeader: z.boolean(),
  hideFooter: z.boolean(),
  hideTitle: z.boolean(),
});

type PageFormValues = z.infer<typeof pageFormSchema>;

interface PageFormProps {
  defaultValues?: Partial<PageFormValues>;
  isEdit?: boolean;
}

export function PageForm({ defaultValues, isEdit = false }: PageFormProps) {
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

      const endpoint = isEdit ? `/api/pages/${values.id}` : "/api/pages";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || error.message || "Failed to save page");
      }

      await response.json();

      toast.success(
        isEdit ? "Page updated successfully!" : "Page created successfully!",
        {
          description: `"${values.title}" has been ${isEdit ? "updated" : "created"}.`,
        },
      );

      // Small delay to show toast before redirect
      setTimeout(() => {
        window.location.href = "/admin/pages";
      }, 500);
    } catch (error: any) {
      console.error("Error submitting form:", error);
      toast.error("Failed to save page", {
        description: error.message || "Please try again.",
        duration: 6000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auto-generate slug from title
  React.useEffect(() => {
    if (!isClient) return;

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
  }, [form, isClient]);

  const slug = form.watch("slug");
  const storefrontPageUrl = getStorefrontPath(slug ? `/${slug}` : "/");

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>
              Enter the basic details of your page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Page Title</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter page title" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input placeholder="page-url-slug" {...field} />
                  </FormControl>
                  <FormDescription>
                    The URL-friendly version of the title. Auto-generated but
                    can be edited.
                  </FormDescription>
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
                      onChange={(e) => {
                        const value = e.target.value;
                        field.onChange(value === "" ? 0 : parseInt(value, 10));
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Pages with lower sort order will appear first in navigation.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Display Options</CardTitle>
            <CardDescription>
              Control the visibility of standard layout elements on this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="hideHeader"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Hide Header</FormLabel>
                    <FormDescription>
                      If checked, the main site header will not be displayed on
                      this page.
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
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Hide Footer</FormLabel>
                    <FormDescription>
                      If checked, the main site footer will not be displayed on
                      this page.
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
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Hide Page Title</FormLabel>
                    <FormDescription>
                      If checked, the page's main title will be hidden from the
                      content area.
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
              name="isPublished"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Page Content</CardTitle>
            <CardDescription>
              Create the content for your page using the rich text editor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="lg:col-span-3 space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Page Content</CardTitle>
                    <CardDescription>
                      Create the content for your page using the rich text
                      editor.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FormField
                      control={form.control}
                      name="content"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            {isClient && (
                              <TiptapEditor
                                content={field.value}
                                onChange={field.onChange}
                                placeholder="Write your page content here..."
                              />
                            )}
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SEO Information</CardTitle>
            <CardDescription>
              Optimize your page for search engines.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        <div className="flex justify-between items-center">
          <div>
            {isEdit && slug && (
              <Button variant="outline" type="button" asChild>
                <a
                  href={storefrontPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" /> Preview Page
                </a>
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" type="button" asChild>
              <a href="/admin/pages">Cancel</a>
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {isEdit ? "Update Page" : "Create Page"}
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
