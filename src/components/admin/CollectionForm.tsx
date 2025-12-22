import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { z } from "zod";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Loader2, Trash2, Layers, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "../ui/badge";

interface Category {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  categoryId: string;
}

const collectionTypes = [
  {
    value: "collection1",
    label: "Collection Style 1",
    description: "Grid layout with featured product (Large card + grid)",
  },
  {
    value: "collection2",
    label: "Collection Style 2",
    description: "Horizontal scrolling product carousel",
  },
] as const;

// Unified collection schema - no validation differences between types
const collectionFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Collection name must be at least 3 characters")
    .max(100, "Collection name must be less than 100 characters"),
  type: z.enum(["collection1", "collection2"]),
  isActive: z.boolean(),
  config: z.object({
    categoryIds: z.array(z.string()),
    productIds: z.array(z.string()),
    featuredProductId: z.string().optional(),
    maxProducts: z.number().int().min(1).max(24),
    title: z.string().optional(),
    subtitle: z.string().optional(),
  }),
});

type CollectionFormValues = z.infer<typeof collectionFormSchema>;

interface CollectionFormProps {
  categories: Category[];
  products: Product[];
  defaultValues?: Partial<CollectionFormValues>;
  isEdit?: boolean;
}

export function CollectionForm({
  categories,
  products,
  defaultValues,
  isEdit = false,
}: CollectionFormProps) {
  const { toast } = useToast();
  const form = useForm<CollectionFormValues>({
    resolver: zodResolver(collectionFormSchema),
    defaultValues: {
      name: "",
      type: "collection1",
      isActive: true,
      config: {
        categoryIds: [],
        productIds: [],
        maxProducts: 8,
        title: "",
        subtitle: "",
      },
      ...defaultValues,
    },
  });

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const selectedType = form.watch("type");
  const selectedCategoryIds = form.watch("config.categoryIds");
  const selectedProductIds = form.watch("config.productIds");

  // Filter products based on selected categories (for easier browsing)
  const filteredProducts = React.useMemo(() => {
    if (selectedCategoryIds.length === 0) {
      return products;
    }
    return products.filter((product) =>
      selectedCategoryIds.includes(product.categoryId),
    );
  }, [selectedCategoryIds, products]);

  // Get selected category objects
  const selectedCategories = React.useMemo(() => {
    return categories.filter((cat) => selectedCategoryIds.includes(cat.id));
  }, [selectedCategoryIds, categories]);

  // Get selected product objects
  const selectedProducts = React.useMemo(() => {
    return products.filter((prod) => selectedProductIds.includes(prod.id));
  }, [selectedProductIds, products]);

  const handleSubmit: SubmitHandler<CollectionFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit
        ? `/api/collections/${values.id}`
        : "/api/collections";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to save collection");
      }

      toast({
        title: "Success",
        description: `Collection ${isEdit ? "updated" : "created"} successfully`,
      });

      window.location.href = "/admin/collections";
    } catch (error) {
      console.error("Error submitting form:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to save collection. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const addCategory = (categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    if (!currentIds.includes(categoryId)) {
      form.setValue("config.categoryIds", [...currentIds, categoryId]);
    }
  };

  const removeCategory = (categoryId: string) => {
    const currentIds = form.getValues("config.categoryIds");
    form.setValue(
      "config.categoryIds",
      currentIds.filter((id) => id !== categoryId),
    );
  };

  const addProduct = (productId: string) => {
    const currentIds = form.getValues("config.productIds");
    if (!currentIds.includes(productId)) {
      form.setValue("config.productIds", [...currentIds, productId]);
    }
  };

  const removeProduct = (productId: string) => {
    const currentIds = form.getValues("config.productIds");
    form.setValue(
      "config.productIds",
      currentIds.filter((id) => id !== productId),
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>
              Enter the basic details of your collection.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Collection Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter collection name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display Style</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value);
                    }}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a display style" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      {collectionTypes.map((type) => (
                        <SelectItem
                          key={type.value}
                          value={type.value}
                          className="flex flex-col items-start py-2"
                        >
                          <div className="font-medium">{type.label}</div>
                          <div className="text-xs text-gray-500">
                            {type.description}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    This only affects how products are displayed on the
                    storefront
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Active Status</FormLabel>
                      <FormDescription>
                        Collection will be visible on the store
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Product Selection</CardTitle>
            <CardDescription>
              Choose which products to include in this collection. You can
              select entire categories, specific products, or both.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Category Selection */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <FormLabel>Categories</FormLabel>
              </div>
              <div className="flex gap-2">
                <Select
                  onValueChange={(value) => {
                    if (value) addCategory(value);
                  }}
                  value=""
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select categories to include..." />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl bg-background max-h-[300px]">
                    {categories
                      .filter((cat) => !selectedCategoryIds.includes(cat.id))
                      .map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedCategories.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedCategories.map((category) => (
                    <Badge
                      key={category.id}
                      variant="secondary"
                      className="flex items-center gap-1 pr-1.5"
                    >
                      <span className="truncate max-w-[180px]">
                        {category.name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                        onClick={() => removeCategory(category.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                        <span className="sr-only">Remove</span>
                      </Button>
                    </Badge>
                  ))}
                </div>
              )}
              <FormDescription>
                All active products from these categories will be included
              </FormDescription>
            </div>

            {/* Product Selection */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                <FormLabel>Specific Products (Optional)</FormLabel>
              </div>
              <div className="flex gap-2">
                <Select
                  onValueChange={(value) => {
                    if (value) addProduct(value);
                  }}
                  value=""
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Add specific products..." />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl bg-background max-h-[300px]">
                    {filteredProducts
                      .filter((prod) => !selectedProductIds.includes(prod.id))
                      .map((product) => (
                        <SelectItem key={product.id} value={product.id}>
                          {product.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedProducts.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selectedProducts.map((product) => (
                    <Badge
                      key={product.id}
                      variant="outline"
                      className="flex items-center gap-1 pr-1.5"
                    >
                      <span className="truncate max-w-[180px]">
                        {product.name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                        onClick={() => removeProduct(product.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                        <span className="sr-only">Remove</span>
                      </Button>
                    </Badge>
                  ))}
                </div>
              )}
              <FormDescription>
                Add specific products that will always be included
              </FormDescription>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Display Settings</CardTitle>
            <CardDescription>
              Configure how the collection will be displayed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="config.title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display Title</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter display title"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <FormDescription>
                    This title will be shown at the top of the collection
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="config.subtitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display Subtitle</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter display subtitle"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional subtitle to display below the title
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {selectedType === "collection1" && (
              <FormField
                control={form.control}
                name="config.featuredProductId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Featured Product (Optional)</FormLabel>
                    <Select
                      onValueChange={(value) => {
                        // Handle "none" value by setting to undefined
                        field.onChange(
                          value === "__NONE__" ? undefined : value,
                        );
                      }}
                      value={field.value || "__NONE__"}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a featured product (optional)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-xl bg-background max-h-[300px]">
                        <SelectItem value="__NONE__">None</SelectItem>
                        {filteredProducts.map((product) => (
                          <SelectItem key={product.id} value={product.id}>
                            {product.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      This product will be displayed prominently in Collection
                      Style 1
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="config.maxProducts"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Maximum Products</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={24}
                      {...field}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Maximum number of products to display (1-24)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex justify-end space-x-4">
          <Button variant="outline" type="button" asChild>
            <a href="/admin/collections">Cancel</a>
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? "Update Collection" : "Create Collection"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
