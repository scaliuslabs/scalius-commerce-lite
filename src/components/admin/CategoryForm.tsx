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
import { TiptapEditor } from "../ui/tiptap-editor";
import { Button } from "../ui/button";
import {
  Loader2,
  X,
  ExternalLink,
  Save
} from "lucide-react";
import { MediaManager } from "./MediaManager";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { CharacterCounter } from "@/components/ui/character-counter";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";

const categoryFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Category name must be at least 3 characters")
    .max(100, "Category name must be less than 100 characters"),
  description: z.string().nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  image: z
    .object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z.date(),
    })
    .nullable(),
  slugEdited: z.boolean().optional(),
});

type CategoryFormValues = z.infer<typeof categoryFormSchema>;

interface CategoryFormProps {
  defaultValues?: Partial<CategoryFormValues>;
  isEdit?: boolean;
}

export function CategoryForm({
  defaultValues,
  isEdit = false,
}: CategoryFormProps) {
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

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const { getStorefrontPath } = useStorefrontUrl();

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

  const handleSubmit: SubmitHandler<CategoryFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit
        ? `/api/categories/${values.id}`
        : "/api/categories";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const data = await response.json();

        if (data.error === "A category with this slug already exists") {
          form.setError("slug", {
            type: "manual",
            message:
              "This slug is already in use. Please choose a different one.",
          });
          toast.error("Slug already in use", {
            description:
              "This slug is already in use. Please choose a different one.",
          });
        } else if (data.details && Array.isArray(data.details)) {
          // Handle Zod validation errors
          data.details.forEach((error: any) => {
            if (error.path && error.path.length > 0) {
              const fieldName = error.path[0] as keyof CategoryFormValues;
              form.setError(fieldName, {
                type: "manual",
                message: error.message,
              });
            }
          });
          toast.error("Validation Error", {
            description: "Please check the form for errors.",
          });
        } else {
          toast.error("Failed to save category", {
            description: data.error || "Please try again.",
            duration: 6000,
          });
        }
        throw new Error(data.error || "Failed to save category");
      }

      toast.success(
        isEdit
          ? "Category updated successfully!"
          : "Category created successfully!",
        {
          description: `"${values.name}" has been ${isEdit ? "updated" : "created"}.`,
        },
      );

      setTimeout(() => {
        window.location.href = "/admin/categories";
      }, 500);
    } catch (error: any) {
      console.error("Error submitting form:", error);
      // Toast notifications are already shown above
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Category Image</CardTitle>
            <CardDescription>
              Add an image for your category (optional).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="image"
              render={({ field }) => (
                <FormItem>
                  <div className="space-y-4">
                    {field.value && (
                      <div className="relative aspect-video w-full max-w-sm">
                        <img
                          src={getOptimizedImageUrl(field.value.url)}
                          alt={field.value.filename}
                          className="h-full w-full rounded-md object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          className="absolute -right-2 -top-2 h-6 w-6"
                          onClick={() => field.onChange(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                    <MediaManager
                      selectedFiles={field.value ? [field.value] : []}
                      onSelect={(file) => field.onChange(file)}
                    />
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>
              Enter the basic details of your category.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter category name"
                      {...field}
                      onChange={(e) => {
                        field.onChange(e);
                        // Auto-generate slug ONLY for new categories and when slug hasn't been manually edited
                        if (!isEdit && !form.getValues("slugEdited")) {
                          const slug = e.target.value
                            .toLowerCase()
                            .replace(/[^\w\s-]/g, "")
                            .replace(/\s+/g, "-")
                            .replace(/^-+|-+$/g, "")
                            .replace(/-+/g, "-");
                          form.setValue("slug", slug, {
                            shouldValidate: true,
                          });
                        }
                      }}
                    />
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
                    {isEdit && field.value && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-2 text-sm font-medium"
                        asChild
                      >
                        <a
                          href={getStorefrontPath(`/categories/${field.value}`)}
                          target="_blank"
                        >
                          <ExternalLink className="h-4 w-4" />
                          View
                        </a>
                      </Button>
                    )}
                  </div>
                  <FormDescription className="text-sm text-muted-foreground/80">
                    The URL-friendly version of the name. Auto-generated from
                    the name but can be edited.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <TiptapEditor
                      content={field.value || ""}
                      onChange={field.onChange}
                      placeholder="Enter category description with rich formatting..."
                      className="min-h-[250px]"
                    />
                  </FormControl>
                  <FormDescription className="text-xs text-muted-foreground">
                    Add a detailed description of this category using rich text
                    formatting. This helps customers understand what products
                    they'll find here.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SEO Information</CardTitle>
            <CardDescription>
              Optimize your category for search engines.
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
                  <FormDescription className="text-xs text-muted-foreground">
                    The title that appears in search engine results. Keep it
                    under 60 characters for best results.
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
                  <FormDescription className="text-xs text-muted-foreground">
                    A brief summary that appears in search results. Aim for
                    150-160 characters to avoid truncation.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex justify-between items-center">
          <div>
            {isEdit && form.getValues("slug") && (
              <Button variant="outline" type="button" asChild>
                <a
                  href={getStorefrontPath(
                    `/categories/${form.getValues("slug")}`,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Preview Category
                </a>
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" type="button" asChild>
              <a href="/admin/categories">Cancel</a>
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
                  {isEdit ? "Update Category" : "Create Category"}
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  );
}
