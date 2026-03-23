import { Link } from "@tanstack/react-router";
import { formatDateShort } from "@scalius/shared/timestamps";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Package,
  Pencil,
  Tag,
  Layers,
  ImageIcon,
  DollarSign,
  PercentIcon,
  ExternalLink,
  Info
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { RichContent } from "../ui/rich-content";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { useCurrency } from "@/hooks/use-currency";

interface ProductVariant {
  id: string;
  size: string | null;
  color: string | null;
  weight: number | null;
  sku: string | null;
  price: number | null;
  stock: number;
  reservedStock: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
  deletedAt: Date | string | number | null;
}

interface ProductImage {
  id: string;
  url: string;
  alt?: string | null;
  altText?: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date | string | number;
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
    createdAt: Date | string | number;
    updatedAt: Date | string | number;
    deletedAt: Date | string | number | null;
    category: {
      name: string | null;
    };
    additionalInfo?: {
      id: string;
      title: string;
      content: string;
      sortOrder: number;
    }[];
    variants: ProductVariant[];
    images: ProductImage[];
  };
}

export function ProductView({ product }: ProductViewProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const { symbol } = useCurrency();
  const primaryImage = product.images.find((img) => img.isPrimary);
  const otherImages = product.images.filter((img) => !img.isPrimary);

  return (
    <div className="container max-w-[1400px] space-y-4 py-4">
      <Card className="border-none shadow-none bg-transparent sm:bg-card">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col lg:flex-row gap-6 lg:items-start justify-between">
            <div className="flex-1 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">
                  {product.name}
                </h1>
                <Badge
                  variant={product.isActive ? "default" : "secondary"}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-semibold",
                    product.isActive
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 hover:bg-emerald-50"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {product.isActive ? "Active" : "Draft"}
                </Badge>
                {product.freeDelivery && (
                  <Badge
                    variant="outline"
                    className="rounded-md px-2 py-0.5 text-xs font-semibold border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-900/30 dark:text-blue-400"
                  >
                    Free Delivery
                  </Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                  <span>Base Price:</span>
                  <span className="font-semibold text-foreground">{symbol}{product.price.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                </div>
                {product.discountPercentage && product.discountPercentage > 0 && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <PercentIcon className="h-4 w-4 text-green-600 dark:text-green-500" />
                    <span>Discount:</span>
                    <span className="font-semibold text-green-600 dark:text-green-500">{product.discountPercentage}% OFF</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Tag className="h-4 w-4" />
                  <span>Category:</span>
                  <span className="font-medium text-foreground">{product.category.name}</span>
                </div>
              </div>

              {product.description && (
                <div className="pt-2">
                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="description" className="border-none">
                      <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline text-foreground transition-colors justify-start gap-2 border rounded-lg px-4 bg-muted/20 data-[state=open]:rounded-b-none data-[state=open]:bg-muted/40">
                        Product Description
                      </AccordionTrigger>
                      <AccordionContent className="pt-4 pb-4 px-4 border border-t-0 rounded-b-lg">
                        <RichContent
                          content={product.description}
                          variant="product"
                          className="text-sm text-foreground/90 max-w-3xl"
                        />
                      </AccordionContent>
                    </AccordionItem>
                    {product.additionalInfo?.map((info, idx) => (
                      <AccordionItem key={`info-${idx}`} value={`info-${idx}`} className="border-none mt-2">
                        <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline text-foreground transition-colors justify-start gap-2 border rounded-lg px-4 bg-muted/20 data-[state=open]:rounded-b-none data-[state=open]:bg-muted/40">
                          {info.title}
                        </AccordionTrigger>
                        <AccordionContent className="pt-4 pb-4 px-4 border border-t-0 rounded-b-lg">
                          <RichContent
                            content={info.content}
                            variant="product"
                            className="text-sm text-foreground/90 max-w-3xl"
                          />
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              )}
              {!product.description && product.additionalInfo && product.additionalInfo.length > 0 && (
                <div className="pt-2">
                  <Accordion type="single" collapsible className="w-full">
                    {product.additionalInfo.map((info, idx) => (
                      <AccordionItem key={`info-${idx}`} value={`info-${idx}`} className="border-none mb-2">
                        <AccordionTrigger className="py-2 text-sm font-semibold hover:no-underline text-foreground transition-colors justify-start gap-2 border rounded-lg px-4 bg-muted/20 data-[state=open]:rounded-b-none data-[state=open]:bg-muted/40">
                          {info.title}
                        </AccordionTrigger>
                        <AccordionContent className="pt-4 pb-4 px-4 border border-t-0 rounded-b-lg">
                          <RichContent
                            content={info.content}
                            variant="product"
                            className="text-sm text-foreground/90 max-w-3xl"
                          />
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row lg:flex-col gap-2 shrink-0">
              <Button size="sm" asChild className="h-8 text-xs font-medium w-full sm:w-auto">
                <Link to={`/admin/products/${product.id}/edit` as string}>
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit Product
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild className="h-8 text-xs font-medium w-full sm:w-auto">
                <a href={getStorefrontPath(`/products/${product.slug}`)} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  View in Store
                </a>
              </Button>
              <div className="text-[10px] text-muted-foreground text-center sm:text-left lg:text-right mt-1 lg:mt-2">
                Last updated {formatDateShort(product.updatedAt)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                Media
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {primaryImage ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Primary</div>
                  <div className="aspect-square overflow-hidden rounded-md border bg-muted/30">
                    <img
                      src={getOptimizedImageUrl(primaryImage.url)}
                      alt={primaryImage.alt || product.name}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  </div>
                </div>
              ) : (
                <div className="aspect-square rounded-md border border-dashed flex items-center justify-center bg-muted/10 text-muted-foreground text-xs">
                  No primary image
                </div>
              )}

              {otherImages.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Gallery</div>
                  <div className="grid grid-cols-3 gap-2">
                    {otherImages.map((image) => (
                      <div key={image.id} className="aspect-square overflow-hidden rounded-md border bg-muted/30">
                        <img
                          src={getOptimizedImageUrl(image.url)}
                          alt={image.alt || product.name}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {(product.metaTitle || product.metaDescription) && (
            <Card>
              <CardHeader className="p-4 border-b">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Info className="h-4 w-4 text-muted-foreground" />
                  Search Engine Optimization
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {product.metaTitle && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Meta Title</div>
                    <div className="text-xs font-medium text-foreground bg-muted/50 p-2 rounded-md border border-border/50">{product.metaTitle}</div>
                  </div>
                )}
                {product.metaDescription && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Meta Description</div>
                    <div className="text-xs text-foreground bg-muted/50 p-2 rounded-md border border-border/50">{product.metaDescription}</div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          <Card className="h-full flex flex-col">
            <CardHeader className="p-4 border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Variants & Inventory
                </CardTitle>
                <Badge variant="secondary" className="font-normal text-[10px] px-1.5 h-5">{product.variants.length} Total</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-auto">
              {product.variants.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Package className="h-8 w-8 mb-2 opacity-20" />
                  <p className="text-sm">No variants configured.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="text-xs font-medium py-2 h-8 pl-4">SKU</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8">Attributes</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">Price</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">On Hand</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">Reserved</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right pr-4">Available</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.map((v) => {
                      const available = v.stock - v.reservedStock;
                      return (
                        <TableRow key={v.id} className="hover:bg-muted/30">
                          <TableCell className="py-2.5 pl-4 font-mono text-xs font-medium">{v.sku}</TableCell>
                          <TableCell className="py-2.5 text-xs text-muted-foreground">
                            {[
                              v.size && `Size: ${v.size}`,
                              v.color && `Color: ${v.color}`,
                              v.weight && `${v.weight}g`,
                            ].filter(Boolean).join(" • ") || "—"}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs font-medium text-right text-foreground">
                            {symbol}{(v.price ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs text-right text-muted-foreground">{v.stock}</TableCell>
                          <TableCell className="py-2.5 text-right">
                            {v.reservedStock > 0 ? (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium border-amber-200 text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800 h-5">
                                {v.reservedStock}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground opacity-30">—</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-right pr-4">
                            <span className={cn(
                              "text-xs font-bold",
                              available <= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-500"
                            )}>
                              {available}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
