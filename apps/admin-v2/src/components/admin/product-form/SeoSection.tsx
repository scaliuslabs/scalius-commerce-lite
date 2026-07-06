// src/components/admin/product-form/SeoSection.tsx
import { memo, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import {
  Braces,
  Globe2,
  Image,
  Link2,
  Rss,
  SearchCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CharacterCounter } from "@/components/ui/character-counter";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/query-keys";
import {
  buildProductSeoDiagnostics,
  type ProductSeoDiagnosticRow,
  type ProductSeoDiagnosticTone,
  type ProductSeoDiagnosticVariant,
  type ProductSeoVariantState,
} from "@/lib/product-seo-diagnostics";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";

interface SeoSectionProps {
  form: UseFormReturn<ProductFormValues>;
  variants?: ProductSeoDiagnosticVariant[];
  variantState?: ProductSeoVariantState;
  storefrontUrl?: string | null;
}

interface CachedSeoSettings {
  discovery?: unknown;
}

const TONE_LABELS: Record<ProductSeoDiagnosticTone, string> = {
  ok: "Ready",
  warning: "Check",
  disabled: "Off",
  draft: "Draft",
  info: "Info",
};

const TONE_CLASSES: Record<ProductSeoDiagnosticTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  disabled: "border-border bg-muted text-muted-foreground",
  draft: "border-border bg-background text-muted-foreground",
  info: "border-sky-200 bg-sky-50 text-sky-700",
};

function DiagnosticRow({
  icon: Icon,
  label,
  row,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  row: ProductSeoDiagnosticRow;
  detail?: string | null;
}) {
  return (
    <div className="flex gap-2 py-2">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{label}</p>
            <p className="text-xs leading-5 text-muted-foreground">
              {row.title}
            </p>
          </div>
          <Badge
            variant="outline"
            className={`h-5 shrink-0 px-1.5 text-[10px] ${TONE_CLASSES[row.tone]}`}
          >
            {TONE_LABELS[row.tone]}
          </Badge>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {row.summary}
        </p>
        {row.value ? (
          <code className="block truncate text-[11px] text-muted-foreground">
            {row.value}
          </code>
        ) : null}
        {detail ? (
          <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}

export const SeoSection = memo(function SeoSection({
  form,
  variants = [],
  variantState = "unavailable",
  storefrontUrl,
}: SeoSectionProps) {
  const queryClient = useQueryClient();
  const cachedSeoSettings = queryClient.getQueryData<CachedSeoSettings>(
    queryKeys.settings.seo(),
  );
  const discovery =
    cachedSeoSettings?.discovery ?? DEFAULT_SEO_DISCOVERY_SETTINGS;
  const policySource = cachedSeoSettings?.discovery ? "current" : "default";
  const productId = form.watch("id");
  const slug = form.watch("slug");
  const isActive = form.watch("isActive");
  const images = form.watch("images");
  const noIndex = form.watch("noIndex");
  const excludeFromSitemap = form.watch("excludeFromSitemap");
  const excludeFromProductFeed = form.watch("excludeFromProductFeed");
  const canonicalPath = form.watch("canonicalPath");

  const diagnostics = useMemo(
    () =>
      buildProductSeoDiagnostics({
        product: {
          id: productId,
          slug,
          canonicalPath,
          isActive,
          images,
          noIndex,
          excludeFromSitemap,
          excludeFromProductFeed,
        },
        variants,
        variantState,
        discovery,
        storefrontUrl,
        policySource,
      }),
    [
      discovery,
      images,
      isActive,
      canonicalPath,
      excludeFromProductFeed,
      excludeFromSitemap,
      noIndex,
      policySource,
      productId,
      slug,
      storefrontUrl,
      variantState,
      variants,
    ],
  );

  return (
    <CollapsibleCard
      title="Search Engine Listing"
      description="Optimize your product for search engines"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <FormField
          control={form.control}
          name="metaTitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm">Page Title</FormLabel>
              <FormControl>
                <Input
                  placeholder="Meta title for SEO"
                  className="h-9"
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
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="metaDescription"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm">Meta Description</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Meta description for SEO"
                  {...field}
                  value={field.value || ""}
                  rows={3}
                  className="resize-none"
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
              <FormLabel className="text-sm">Canonical Path</FormLabel>
              <FormControl>
                <Input
                  placeholder="/products/main-shoe"
                  className="h-9"
                  {...field}
                  value={field.value || ""}
                  onChange={(event) => {
                    field.onChange(event.target.value || null);
                  }}
                />
              </FormControl>
              <FormDescription className="text-xs">
                Optional same-store path for duplicate or campaign pages. Leave blank to use this product page.
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
                    Keep the product page public, but ask search engines not to index it.
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
                    Keep the product page public, but remove it from product sitemap XML.
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
            name="excludeFromProductFeed"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <FormLabel className="text-sm font-medium">
                    Hide from product feed
                  </FormLabel>
                  <FormDescription className="text-xs">
                    Keep it on the storefront, but remove it from catalog feed XML.
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

        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SearchCheck className="h-3.5 w-3.5 text-muted-foreground" />
                <h4 className="text-sm font-medium">Discovery Readiness</h4>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Expected after save from product data and global discovery
                policy.
              </p>
            </div>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {diagnostics.policy.label}
            </Badge>
          </div>

          <div className="divide-y divide-border">
            <DiagnosticRow
              icon={Link2}
              label="Canonical"
              row={diagnostics.canonical}
            />
            <DiagnosticRow
              icon={Globe2}
              label="Sitemap XML"
              row={diagnostics.sitemap}
              detail={diagnostics.availability.summary}
            />
            <DiagnosticRow
              icon={Image}
              label="Feed image"
              row={diagnostics.feedImage}
            />
            <DiagnosticRow
              icon={Rss}
              label="Catalog feed"
              row={diagnostics.feed}
              detail={diagnostics.feed.skippedReason}
            />
            <DiagnosticRow
              icon={Braces}
              label="Product JSON-LD"
              row={diagnostics.structuredData}
            />
          </div>

          {diagnostics.policy.source === "default" ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {diagnostics.policy.summary}
            </p>
          ) : null}
        </div>
      </div>
    </CollapsibleCard>
  );
});
