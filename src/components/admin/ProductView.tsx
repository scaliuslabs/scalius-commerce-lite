//src/components/admin/ProductView.tsx
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Package,
  Pencil,
  Tag,
  Layers,
  ImageIcon,
  DollarSign,
  PercentIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RichContent } from "../ui/rich-content";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";

interface ProductVariant {
  id: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string;
  price: number;
  stock: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface ProductImage {
  id: string;
  url: string;
  alt: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date;
}

interface ProductViewProps {
  product: {
    id: string;
    name: string;
    description: string | null;
    price: number;
    categoryId: string;
    slug: string;
    metaTitle: string | null;
    metaDescription: string | null;
    isActive: boolean;
    discountPercentage: number | null;
    freeDelivery: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    category: {
      name: string;
    };
    variants: ProductVariant[];
    images: ProductImage[];
  };
}

export function ProductView({ product }: ProductViewProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const primaryImage = product.images.find((img) => img.isPrimary);
  const otherImages = product.images.filter((img) => !img.isPrimary);

  return (
    <div className="container max-w-[1400px] space-y-4 py-4">
      {/* Header */}
      <div className="relative rounded-xl bg-card border border-border p-4 shadow-sm">
        <div className="grid gap-4 lg:grid-cols-12">
          {/* Product Info */}
          <div className="lg:col-span-8">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-xl font-semibold text-foreground">
                {product.name}
              </h2>
              <Badge
                variant={product.isActive ? "default" : "secondary"}
                className={cn(
                  "text-xs font-medium",
                  product.isActive
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {product.isActive ? "Active" : "Inactive"}
              </Badge>
              {product.freeDelivery && (
                <Badge
                  variant="secondary"
                  className="bg-blue-50 text-xs font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                >
                  Free Delivery
                </Badge>
              )}
            </div>
            <div className="grid gap-4">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <DollarSign className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">
                      Base Price
                    </div>
                    <div className="text-base font-medium text-foreground">
                      ৳{product.price.toLocaleString()}
                    </div>
                  </div>
                </div>

                {product.discountPercentage &&
                  product.discountPercentage > 0 && (
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                        <PercentIcon className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">
                          Discount
                        </div>
                        <div className="text-base font-medium text-green-600 dark:text-green-400">
                          {product.discountPercentage}% OFF
                        </div>
                      </div>
                    </div>
                  )}

                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                    <Tag className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-muted-foreground">
                      Category
                    </div>
                    <div className="text-base text-foreground">
                      {product.category.name}
                    </div>
                  </div>
                </div>
              </div>

              {product.description && (
                <RichContent
                  content={product.description}
                  variant="product"
                  className="mt-4"
                />
              )}

              {(product.metaTitle || product.metaDescription) && (
                <div className="space-y-2 rounded-lg bg-muted/30 p-3">
                  <h3 className="text-sm font-medium text-foreground">
                    SEO Info
                  </h3>
                  {product.metaTitle && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">
                        Meta Title
                      </div>
                      <div className="text-sm text-foreground">
                        {product.metaTitle}
                      </div>
                    </div>
                  )}
                  {product.metaDescription && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">
                        Meta Description
                      </div>
                      <div className="text-sm text-foreground">
                        {product.metaDescription}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="lg:col-span-4 flex flex-col items-end justify-between">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5"
              >
                <a href={`/admin/products/${product.id}/edit`}>
                  <Pencil className="h-4 w-4" />
                  Edit Product
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 gap-1.5 rounded-lg border-primary/20 px-3 text-sm font-medium hover:bg-primary/5"
              >
                <a
                  href={getStorefrontPath(`/products/${product.slug}`)}
                  target="_blank"
                >
                  <Package className="h-4 w-4" />
                  View Live
                </a>
              </Button>
            </div>
            <div className="text-sm text-muted-foreground">
              Last updated {product.updatedAt.toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Left Column - Images */}
        <div className="lg:col-span-4">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="h-4 w-4" />
                Product Images
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-4">
                {primaryImage && (
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-2">
                      Primary Image
                    </div>
                    <div className="aspect-square overflow-hidden rounded-lg border border-border bg-background">
                      <img
                        src={getOptimizedImageUrl(primaryImage.url)}
                        alt={primaryImage.alt || product.name}
                        className="h-full w-full object-cover object-center"
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  </div>
                )}

                {otherImages.length > 0 && (
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-2">
                      Additional Images
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {otherImages.map((image) => (
                        <div
                          key={image.id}
                          className="aspect-square overflow-hidden rounded-lg border border-border bg-background"
                        >
                          <img
                            src={getOptimizedImageUrl(image.url)}
                            alt={image.alt || product.name}
                            className="h-full w-full object-cover object-center"
                            loading="lazy"
                            decoding="async"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Variants */}
        <div className="lg:col-span-8">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4" />
                Product Variants ({product.variants.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {product.variants.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    No variants available
                  </div>
                ) : (
                  product.variants.map((variant) => (
                    <div
                      key={variant.id}
                      className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/5"
                    >
                      <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            SKU
                          </div>
                          <div className="text-sm font-mono text-muted-foreground">
                            {variant.sku}
                          </div>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Attributes
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {[
                              variant.size && `Size: ${variant.size}`,
                              variant.color && `Color: ${variant.color}`,
                              variant.weight &&
                                `Weight: ${variant.weight.toLocaleString()}g`,
                            ]
                              .filter(Boolean)
                              .join(", ") || "-"}
                          </div>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Price
                          </div>
                          <div className="text-sm text-muted-foreground">
                            ৳{variant.price.toLocaleString()}
                          </div>
                        </div>
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            Stock
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {variant.stock} units
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
