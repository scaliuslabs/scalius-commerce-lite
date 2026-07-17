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
  Play,
  Video,
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
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import type { ProductDetail, ProductMediaDetail } from "@/types/api-responses";
import {
  normalizeProductCondition,
  PRODUCT_CONDITION_LABELS,
} from "@scalius/shared/product-condition";

interface ProductViewProps { product: ProductDetail }

export function ProductView({ product }: ProductViewProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const { formatPrice } = useCurrency();
  const { products: productActions } = useCatalogActionPermissions();
  const featuredMedia = product.media.find((item) => item.isPrimary)
    ?? [...product.media].sort((left, right) => left.sortOrder - right.sortOrder)[0];
  const otherMedia = product.media.filter((item) => item.id !== featuredMedia?.id);
  const visibleMetaDescription = product.metaDescription?.trim() || null;
  const statusLabel = product.deletedAt
    ? "Trashed"
    : product.isActive
      ? "Active"
      : "Draft";
  const conditionLabel = PRODUCT_CONDITION_LABELS[
    normalizeProductCondition(product.productCondition)
  ];
  const productDiscount = product.discountType === "flat"
    ? product.discountAmount && product.discountAmount > 0
      ? `${formatPrice(product.discountAmount)} off`
      : null
    : product.discountPercentage && product.discountPercentage > 0
      ? `${product.discountPercentage}% off`
      : null;

  return (
    <div className="container max-w-[1400px] space-y-3 py-3">
      <Card className="border-none shadow-none bg-transparent sm:bg-card">
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-foreground">
                  {product.name}
                </h1>
                <Badge
                  variant={product.isActive && !product.deletedAt ? "default" : "secondary"}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-semibold",
                    product.isActive && !product.deletedAt
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 hover:bg-emerald-50"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {statusLabel}
                </Badge>
                {product.freeDelivery && (
                  <Badge
                    variant="outline"
                    className="rounded-md px-2 py-0.5 text-xs font-semibold border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-900/30 dark:text-blue-400"
                  >
                    Free Delivery
                  </Badge>
                )}
                <Badge variant="outline" className="rounded-md px-1.5 py-0 text-[10px] text-muted-foreground">
                  {conditionLabel}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                  <span>Base Price:</span>
                  <span className="font-semibold text-foreground">{formatPrice(product.price)}</span>
                </div>
                {productDiscount && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <PercentIcon className="h-4 w-4 text-green-600 dark:text-green-500" />
                    <span>Discount:</span>
                    <span className="font-semibold text-green-600 dark:text-green-500">{productDiscount}</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Tag className="h-4 w-4" />
                  <span>Category:</span>
                  <span className="font-medium text-foreground">
                    {product.category?.name || "Uncategorized"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 text-[10px]">
                  <Badge variant="outline" className={product.noIndex ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}>
                    {product.noIndex ? "Noindex" : "Indexable"}
                  </Badge>
                  <Badge variant="outline" className={product.excludeFromSitemap ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-400"}>
                    {product.excludeFromSitemap ? "Not in sitemap" : "In sitemap"}
                  </Badge>
                  <Badge variant="outline" className={product.excludeFromProductFeed ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-400"}>
                    {product.excludeFromProductFeed ? "Not in feed" : "In feed"}
                  </Badge>
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
              {productActions.canEdit && (
                <Button size="sm" asChild className="h-8 text-xs font-medium w-full sm:w-auto">
                  <Link to={`/admin/products/${product.id}/edit` as string}>
                    <Pencil className="mr-2 h-3.5 w-3.5" />
                    Edit Product
                  </Link>
                </Button>
              )}
              <Button variant="outline" size="sm" asChild className="h-8 text-xs font-medium w-full sm:w-auto">
                <a href={getStorefrontPath(`/products/${product.slug}`)} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  View in Store
                </a>
              </Button>
              <div className="text-[10px] text-muted-foreground text-center sm:text-left lg:text-right mt-1 lg:mt-2">
                Last updated{" "}
                <span suppressHydrationWarning>
                  {formatDateShort(product.updatedAt)}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-muted-foreground" />
                Media
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {featuredMedia ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span>Featured {featuredMedia.kind}</span>
                    {featuredMedia.status === "trashed" ? <Badge variant="outline" className="text-amber-700 dark:text-amber-400">In trash</Badge> : null}
                  </div>
                  <div className="aspect-square overflow-hidden rounded-md border bg-muted/30">
                    <ProductMediaPreview item={featuredMedia} productName={product.name} featured />
                  </div>
                  {featuredMedia.kind === "video" && !featuredMedia.posterUrl ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">No poster. Image-only surfaces use the next usable image.</p>
                  ) : null}
                </div>
              ) : (
                <div className="aspect-square rounded-md border border-dashed flex items-center justify-center bg-muted/10 text-muted-foreground text-xs">
                  No product media
                </div>
              )}

              {otherMedia.length > 0 && (
                <div className="space-y-2 pt-2 border-t">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Gallery</div>
                  <div className="grid grid-cols-3 gap-2">
                    {otherMedia.map((item) => (
                      <div key={item.id} className="relative aspect-square overflow-hidden rounded-md border bg-muted/30">
                        <ProductMediaPreview item={item} productName={product.name} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {(product.metaTitle || visibleMetaDescription) && (
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
                {visibleMetaDescription && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Meta Description</div>
                    <div className="text-xs text-foreground bg-muted/50 p-2 rounded-md border border-border/50">{visibleMetaDescription}</div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div>
          <Card>
            <CardHeader className="p-4 border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Variants & Inventory
                </CardTitle>
                <Badge variant="secondary" className="font-normal text-[10px] px-1.5 h-5">{product.variants.length} Total</Badge>
              </div>
            </CardHeader>
            <CardContent className="overflow-auto p-0">
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
                      <TableHead className="text-xs font-medium py-2 h-8">Options</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">Price</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">On Hand</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right">Reserved</TableHead>
                      <TableHead className="text-xs font-medium py-2 h-8 text-right pr-4">Available</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.map((v) => {
                      const isSimpleDefaultSku = v.isDefault === true && !v.optionCombinationKey;
                      const inventoryTracked = v.trackInventory !== false;
                      const available = inventoryTracked ? v.stock - v.reservedStock : null;
                      const variantDiscount = v.discountType === "flat"
                        ? v.discountAmount && v.discountAmount > 0
                          ? `${formatPrice(v.discountAmount)} off`
                          : null
                        : v.discountType === "percentage" && v.discountPercentage && v.discountPercentage > 0
                          ? `${v.discountPercentage}% off`
                          : null;
                      const attributes = isSimpleDefaultSku
                        ? "Product SKU"
                        : [
                            ...v.selectedOptions.map((option) => `${option.name}: ${option.value}`),
                            v.weight && `${v.weight}g`,
                          ].filter(Boolean).join(" • ") || "—";
                      return (
                        <TableRow key={v.id} className="hover:bg-muted/30">
                          <TableCell className="py-2.5 pl-4 font-mono text-xs font-medium">{v.sku}</TableCell>
                          <TableCell className="py-2.5 text-xs text-muted-foreground">
                            {attributes}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs font-medium text-right text-foreground">
                            <div>{formatPrice(v.price ?? product.price)}</div>
                            {variantDiscount && (
                              <div className="text-[10px] font-normal text-emerald-600 dark:text-emerald-400">
                                {variantDiscount}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-xs text-right text-muted-foreground">
                            {inventoryTracked ? v.stock : "No stock limit"}
                          </TableCell>
                          <TableCell className="py-2.5 text-right">
                            {inventoryTracked && v.reservedStock > 0 ? (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium border-amber-200 text-amber-700 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800 h-5">
                                {v.reservedStock}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground opacity-30">—</span>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-right pr-4">
                            {available === null ? (
                              <Badge variant="outline" className="h-5 border-emerald-200 bg-emerald-50 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300">
                                No stock limit
                              </Badge>
                            ) : (
                              <span className={cn(
                                "text-xs font-bold",
                                available < 0
                                  ? "text-red-700 dark:text-red-400"
                                  : available === 0
                                    ? "text-amber-700 dark:text-amber-400"
                                    : "text-emerald-700 dark:text-emerald-500"
                              )}>
                                {available < 0 ? `${available} deficit` : available}
                              </span>
                            )}
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

function ProductMediaPreview({ item, productName, featured = false }: {
  item: ProductMediaDetail;
  productName: string;
  featured?: boolean;
}) {
  if (item.kind === "image") {
    return (
      <img
        src={getOptimizedImageUrl(item.url, {
          width: featured ? 960 : 240,
          height: featured ? 960 : 240,
          quality: featured ? 85 : 75,
          fit: "contain",
        })}
        alt={item.altText || productName}
        className="h-full w-full object-contain object-center"
        loading="lazy"
        decoding="async"
      />
    );
  }
  if (featured) {
    return (
      <video
        src={item.url}
        poster={item.posterUrl ? getOptimizedImageUrl(item.posterUrl) : undefined}
        aria-label={item.altText || `${productName} video`}
        className="h-full w-full object-contain"
        controls
        playsInline
        preload="metadata"
      />
    );
  }
  return (
    <>
      {item.posterUrl ? (
        <img
          src={getOptimizedImageUrl(item.posterUrl, { width: 240, height: 240, quality: 75, fit: "contain" })}
          alt=""
          className="h-full w-full object-contain object-center"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-full items-center justify-center"><Video className="h-5 w-5 text-muted-foreground" /></div>
      )}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white"><Play className="ml-0.5 h-3 w-3 fill-current" /></span>
      </span>
      <span className="sr-only">Video: {item.altText || productName}</span>
    </>
  );
}
