import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  Globe2,
  Loader2,
  Rss,
  Search,
  AlertCircle,
  Truck,
  Undo2,
} from "lucide-react";
import {
  DEFAULT_SEO_DISCOVERY_SETTINGS,
  type SeoFeedVariantStrategy,
} from "@scalius/shared/seo-discovery";
import {
  DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  normalizeSeoReturnPolicySettings,
  type SeoReturnPolicyCategory,
  type SeoReturnPolicyFees,
  type SeoReturnPolicyMethod,
  type SeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CharacterCounter } from "@/components/ui/character-counter";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SeoDiscoveryStatusCard } from "./SeoDiscoveryStatusCard";
import {
  normalizeSeoDiscoverySettingsWithReturnPolicy,
  type SeoDiscoverySettingsWithReturnPolicy,
} from "@/lib/seo-discovery-status";
import {
  getBusinessSettings,
  getSeoSettings,
  updateSeoSettings,
  type UpdateSeoSettingsInput,
} from "@/lib/api-functions/settings";
import { generalSettingsQueryOptions } from "@/lib/api-query-options/settings";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";

interface SeoConfig {
  siteTitle: string;
  homepageTitle: string;
  homepageMetaDescription: string;
  robotsTxt: string;
  discovery: SeoDiscoverySettingsWithReturnPolicy;
}

interface SeoSettingsPayloadWithReturnPolicy {
  discovery?: unknown;
  returnPolicy?: unknown;
}

const DEFAULT_RETURN_WINDOW_DAYS = 7;

const defaultConfig: SeoConfig = {
  siteTitle: "",
  homepageTitle: "",
  homepageMetaDescription: "",
  robotsTxt: `User-agent: *\nAllow: /`,
  discovery: {
    ...DEFAULT_SEO_DISCOVERY_SETTINGS,
    returnPolicy: DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  },
};

function readReturnPolicy(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { returnPolicy?: unknown }).returnPolicy
    : undefined;
}

function normalizeSeoDiscoveryPayload(
  data: SeoSettingsPayloadWithReturnPolicy,
): SeoDiscoverySettingsWithReturnPolicy {
  const discovery = normalizeSeoDiscoverySettingsWithReturnPolicy(data.discovery);
  const returnPolicySource =
    readReturnPolicy(data.discovery) ?? data.returnPolicy ?? discovery.returnPolicy;

  return {
    ...discovery,
    returnPolicy: normalizeSeoReturnPolicySettings(returnPolicySource),
  };
}

function sanitizeSeoConfig(values: SeoConfig): SeoConfig {
  return {
    ...values,
    discovery: {
      ...values.discovery,
      returnPolicy: normalizeSeoReturnPolicySettings(
        values.discovery.returnPolicy,
      ),
    },
  };
}

function isInvalidReturnPolicyUrl(value: string): boolean {
  return (
    value.trim() !== "" &&
    normalizeSeoReturnPolicySettings({ policyUrl: value }).policyUrl === ""
  );
}

const fetchSeo = async (): Promise<SeoConfig> => {
  const data = await getSeoSettings();
  const dataWithReturnPolicy = data as SeoSettingsPayloadWithReturnPolicy;
  return {
    siteTitle: data.siteTitle || defaultConfig.siteTitle,
    homepageTitle: data.homepageTitle || defaultConfig.homepageTitle,
    homepageMetaDescription:
      data.homepageMetaDescription || defaultConfig.homepageMetaDescription,
    robotsTxt:
      typeof data.robotsTxt === "string"
        ? data.robotsTxt
        : defaultConfig.robotsTxt,
    discovery: normalizeSeoDiscoveryPayload(dataWithReturnPolicy),
  };
};

const saveSeo = async (values: SeoConfig) => {
  const sanitized = sanitizeSeoConfig(values);
  const { returnPolicy, ...discovery } = sanitized.discovery;
  const payload: UpdateSeoSettingsInput = {
    siteTitle: sanitized.siteTitle,
    homepageTitle: sanitized.homepageTitle,
    homepageMetaDescription: sanitized.homepageMetaDescription,
    robotsTxt: sanitized.robotsTxt,
    discovery,
    returnPolicy,
  };
  await updateSeoSettings({
    data: payload,
  });
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readHeaderLogoReady(settings: unknown): boolean | null {
  if (!settings) return null;
  const headerConfig = asRecord(asRecord(settings).headerConfig);
  const logo = asRecord(headerConfig.logo);
  return typeof logo.src === "string" && logo.src.trim().length > 0;
}

export function SeoSettingsBuilder() {
  const businessSettingsQuery = useQuery({
    queryKey: queryKeys.settings.business(),
    queryFn: async () => getBusinessSettings(),
    staleTime: 1000 * 60 * 5,
  });
  const generalSettingsQuery = useQuery(generalSettingsQueryOptions());
  const {
    values,
    setValues,
    isLoading,
    isLoadError,
    loadError,
    isSaving,
    handleSubmit,
    refetch,
  } =
    useSettingsForm<SeoConfig>({
      queryKey: queryKeys.settings.seo(),
      fetchFn: fetchSeo,
      saveFn: saveSeo,
      defaultValues: defaultConfig,
      invalidateQueryKeys: [
        queryKeys.settings.seoDiscoveryLiveProbe(),
        queryKeys.settings.seoFeedDiagnostics(),
      ],
      successMessage: "SEO settings saved successfully.",
      errorMessage: "Failed to save SEO settings.",
    });

  const updateField = useCallback(
    <K extends keyof SeoConfig>(key: K, value: SeoConfig[K]) => {
      setValues((prev) => ({ ...prev, [key]: value }));
    },
    [setValues],
  );

  const updateDiscovery = useCallback(
    <
      Section extends keyof SeoDiscoverySettingsWithReturnPolicy,
      Key extends keyof SeoDiscoverySettingsWithReturnPolicy[Section],
    >(
      section: Section,
      key: Key,
      value: SeoDiscoverySettingsWithReturnPolicy[Section][Key],
    ) => {
      setValues((prev) => ({
        ...prev,
        discovery: {
          ...prev.discovery,
          [section]: {
            ...prev.discovery[section],
            [key]: value,
          },
        },
      }));
    },
    [setValues],
  );

  const updateReturnPolicy = useCallback(
    (patch: Partial<SeoReturnPolicySettings>) => {
      setValues((prev) => ({
        ...prev,
        discovery: {
          ...prev.discovery,
          returnPolicy: {
            ...prev.discovery.returnPolicy,
            ...patch,
          },
        },
      }));
    },
    [setValues],
  );

  const discoveryRows = [
    {
      icon: Globe2,
      title: "Sitemap",
      rows: [
        ["enabled", "Generate sitemap.xml"] as const,
        ["staticPages", "Home + search"] as const,
        ["products", "Products"] as const,
        ["categories", "Categories"] as const,
        ["collections", "Collections"] as const,
        ["pages", "Pages"] as const,
      ],
    },
  ];
  const returnPolicy = values.discovery.returnPolicy;
  const isFiniteReturnPolicy = returnPolicy.category === "finite";
  const isNoReturnsPolicy = returnPolicy.category === "no_returns";
  const returnPolicyUrlInvalid = isInvalidReturnPolicyUrl(
    returnPolicy.policyUrl,
  );
  const businessSettings = businessSettingsQuery.data;
  const businessIdentity = {
    companyName:
      typeof businessSettings?.companyName === "string"
        ? businessSettings.companyName
        : "",
    legalName:
      typeof businessSettings?.legalName === "string"
        ? businessSettings.legalName
        : "",
  };
  const hasStoreLogo = readHeaderLogoReady(generalSettingsQuery.data);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isLoadError) {
    const message =
      loadError instanceof Error && loadError.message
        ? loadError.message
        : "SEO settings could not be loaded. Existing search settings were not changed.";

    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>SEO settings unavailable</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{message}</p>
          <Button type="button" variant="outline" onClick={refetch}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="site-title">Global Site Title</Label>
          <Input
            id="site-title"
            value={values.siteTitle}
            onChange={(e) => updateField("siteTitle", e.target.value)}
            placeholder="Your Awesome Store - Gadgets, Gizmos, and More"
          />
          {values.siteTitle && (
            <CharacterCounter
              current={values.siteTitle.length}
              recommended={60}
              max={70}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Default title for your site. Keep it concise and descriptive.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="homepage-title">Homepage Title</Label>
          <Input
            id="homepage-title"
            value={values.homepageTitle}
            onChange={(e) => updateField("homepageTitle", e.target.value)}
            placeholder="Welcome to Your Awesome Store | Shop Online"
          />
          {values.homepageTitle && (
            <CharacterCounter
              current={values.homepageTitle.length}
              recommended={60}
              max={70}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Title shown in browser tabs and search results for your homepage.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="homepage-meta-description">
          Homepage Meta Description
        </Label>
        <Textarea
          id="homepage-meta-description"
          value={values.homepageMetaDescription}
          onChange={(e) =>
            updateField("homepageMetaDescription", e.target.value)
          }
          placeholder="Describe your homepage in a way that attracts users from search results."
          rows={3}
        />
        {values.homepageMetaDescription && (
          <CharacterCounter
            current={values.homepageMetaDescription.length}
            recommended={160}
            max={200}
          />
        )}
      </div>

      <Alert variant="default">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Title Usage</AlertTitle>
        <AlertDescription>
          Individual pages, products, and categories can override these global
          settings with their own meta titles.
        </AlertDescription>
      </Alert>

      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Discovery Controls</h3>
            <p className="text-xs text-muted-foreground">
              Choose which public discovery files and global schema are emitted.
            </p>
          </div>
        </div>

        <div className="grid gap-0 md:grid-cols-2">
          {discoveryRows.map((section) => (
            <div key={section.title} className="border-b border-border p-4 md:border-r">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <section.icon className="h-4 w-4 text-muted-foreground" />
                {section.title}
              </div>
              <div className="space-y-3">
                {section.rows.map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span>{label}</span>
                    <Switch
                      checked={values.discovery.sitemap[key]}
                      onCheckedChange={(checked) =>
                        updateDiscovery("sitemap", key, checked)
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="border-b border-border p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Rss className="h-4 w-4 text-muted-foreground" />
              Product Catalog Feed
            </div>
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Generate product feed XML</span>
                <Switch
                  checked={values.discovery.feeds.productCatalogEnabled}
                  onCheckedChange={(checked) =>
                    updateDiscovery("feeds", "productCatalogEnabled", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Include sold-out items</span>
                <Switch
                  checked={values.discovery.feeds.includeUnavailableProducts}
                  onCheckedChange={(checked) =>
                    updateDiscovery("feeds", "includeUnavailableProducts", checked)
                  }
                />
              </label>
              <div className="grid gap-2">
                <Label htmlFor="feed-variant-strategy" className="text-xs">
                  Feed output mode
                </Label>
                <Select
                  value={values.discovery.feeds.variantStrategy}
                  onValueChange={(value) =>
                    updateDiscovery(
                      "feeds",
                      "variantStrategy",
                      value as SeoFeedVariantStrategy,
                    )
                  }
                >
                  <SelectTrigger id="feed-variant-strategy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="variants">SKU / variant rows</SelectItem>
                    <SelectItem value="products">Product rows</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs leading-5 text-muted-foreground">
                  Use SKU / variant rows for products with options. Use product
                  rows only when a catalog tool should receive one row per
                  product.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="feed-title" className="text-xs">
                  Feed title
                </Label>
                <Input
                  id="feed-title"
                  value={values.discovery.feeds.title}
                  onChange={(event) =>
                    updateDiscovery("feeds", "title", event.target.value)
                  }
                  placeholder="Product Catalog"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="feed-description" className="text-xs">
                  Feed description
                </Label>
                <Input
                  id="feed-description"
                  value={values.discovery.feeds.description}
                  onChange={(event) =>
                    updateDiscovery("feeds", "description", event.target.value)
                  }
                  placeholder="Complete product catalog for feed tools"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Controls the Google/Base RSS product catalog at
                `/api/product-feed.xml`; `/api/facebook-feed.xml` remains as a
                compatibility alias for existing Meta catalog syncs.
              </p>
            </div>
          </div>

          <div className="p-4 md:border-r">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Globe2 className="h-4 w-4 text-muted-foreground" />
              robots.txt
            </div>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>Advertise sitemap URL</span>
              <Switch
                checked={values.discovery.robots.advertiseSitemap}
                onCheckedChange={(checked) =>
                  updateDiscovery("robots", "advertiseSitemap", checked)
                }
              />
            </label>
          </div>

          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Braces className="h-4 w-4 text-muted-foreground" />
              Structured Data
            </div>
            <div className="space-y-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Organization schema</span>
                <Switch
                  checked={values.discovery.structuredData.organization}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "organization", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Website search schema</span>
                <Switch
                  checked={values.discovery.structuredData.websiteSearch}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "websiteSearch", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Product schema</span>
                <Switch
                  checked={values.discovery.structuredData.products}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "products", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>ProductGroup variant schema</span>
                <Switch
                  checked={values.discovery.structuredData.productGroups}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "productGroups", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span className="inline-flex items-center gap-2">
                  <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                  Offer shipping schema
                </span>
                <Switch
                  checked={values.discovery.structuredData.offerShippingDetails}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "offerShippingDetails", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Breadcrumb schema</span>
                <Switch
                  checked={values.discovery.structuredData.breadcrumbs}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "breadcrumbs", checked)
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Collection schema</span>
                <Switch
                  checked={values.discovery.structuredData.collections}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "collections", checked)
                  }
                />
              </label>
            </div>
          </div>

          <div className="border-t border-border p-4 md:col-span-2">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Return Policy Schema
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Saves return-policy facts for OnlineStore/Product schema;
                    it does not change checkout, refunds, or order handling.
                  </p>
                </div>
              </div>
              <label className="flex shrink-0 items-center justify-between gap-3 text-sm lg:min-w-[220px]">
                <span>Emit return policy schema</span>
                <Switch
                  checked={returnPolicy.enabled}
                  onCheckedChange={(checked) =>
                    updateReturnPolicy({
                      enabled: checked,
                      ...(checked &&
                      returnPolicy.category === "finite" &&
                      returnPolicy.returnWindowDays === null
                        ? { returnWindowDays: DEFAULT_RETURN_WINDOW_DAYS }
                        : {}),
                    })
                  }
                />
              </label>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="grid gap-2">
                <Label htmlFor="return-policy-country" className="text-xs">
                  Country
                </Label>
                <Input
                  id="return-policy-country"
                  value={returnPolicy.country}
                  maxLength={2}
                  onChange={(event) =>
                    updateReturnPolicy({
                      country: event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z]/g, "")
                        .slice(0, 2),
                    })
                  }
                  placeholder="BD"
                  className="uppercase"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="return-policy-category" className="text-xs">
                  Return category
                </Label>
                <Select
                  value={returnPolicy.category}
                  onValueChange={(value) => {
                    const category = value as SeoReturnPolicyCategory;
                    updateReturnPolicy({
                      category,
                      returnWindowDays:
                        category === "finite"
                          ? returnPolicy.returnWindowDays ??
                            DEFAULT_RETURN_WINDOW_DAYS
                          : null,
                    });
                  }}
                >
                  <SelectTrigger id="return-policy-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="finite">Finite return window</SelectItem>
                    <SelectItem value="unlimited">Unlimited returns</SelectItem>
                    <SelectItem value="no_returns">No returns</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isFiniteReturnPolicy ? (
                <div className="grid gap-2">
                  <Label htmlFor="return-window-days" className="text-xs">
                    Return window days
                  </Label>
                  <Input
                    id="return-window-days"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={returnPolicy.returnWindowDays ?? ""}
                    onChange={(event) =>
                      updateReturnPolicy({
                        returnWindowDays:
                          event.target.value === ""
                            ? null
                            : Number(event.target.value),
                      })
                    }
                    placeholder="7"
                  />
                </div>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor="return-policy-fees" className="text-xs">
                  Return fees
                </Label>
                <Select
                  value={returnPolicy.returnFees}
                  onValueChange={(value) =>
                    updateReturnPolicy({
                      returnFees: value as SeoReturnPolicyFees,
                    })
                  }
                  disabled={isNoReturnsPolicy}
                >
                  <SelectTrigger id="return-policy-fees">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">Free returns</SelectItem>
                    <SelectItem value="customer_responsibility">
                      Buyer pays return fees
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="return-policy-method" className="text-xs">
                  Return method
                </Label>
                <Select
                  value={returnPolicy.returnMethod}
                  onValueChange={(value) =>
                    updateReturnPolicy({
                      returnMethod: value as SeoReturnPolicyMethod,
                    })
                  }
                  disabled={isNoReturnsPolicy}
                >
                  <SelectTrigger id="return-policy-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mail">Return by mail</SelectItem>
                    <SelectItem value="in_store">Return in store</SelectItem>
                    <SelectItem value="both">
                      Mail or in-store returns
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2 md:col-span-2 xl:col-span-3">
                <Label htmlFor="return-policy-url" className="text-xs">
                  Policy URL
                </Label>
                <Input
                  id="return-policy-url"
                  value={returnPolicy.policyUrl}
                  onChange={(event) =>
                    updateReturnPolicy({ policyUrl: event.target.value })
                  }
                  onBlur={(event) =>
                    updateReturnPolicy({ policyUrl: event.target.value.trim() })
                  }
                  placeholder="/returns"
                />
                {returnPolicyUrlInvalid ? (
                  <p className="text-xs leading-5 text-amber-700">
                    Use a same-origin path like /returns or an absolute http(s)
                    URL. Invalid policy URLs are omitted on save.
                  </p>
                ) : (
                  <p className="text-xs leading-5 text-muted-foreground">
                    Optional. Leave blank until the public return policy page is
                    ready.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <SeoDiscoveryStatusCard
        discovery={values.discovery}
        robotsTxt={values.robotsTxt}
        businessIdentity={businessIdentity}
        hasStoreLogo={hasStoreLogo}
      />

      <div className="space-y-2">
        <Label htmlFor="robots-txt">robots.txt Content</Label>
        <Textarea
          id="robots-txt"
          value={values.robotsTxt}
          onChange={(e) => updateField("robotsTxt", e.target.value)}
          placeholder={`User-agent: *\nAllow: /`}
          rows={6}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Crawler rules only. Sitemap lines are managed by the Advertise
          sitemap URL switch and normalized to the current Store URL.
        </p>
      </div>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={handleSubmit}
          disabled={isSaving}
          className="min-w-[120px]"
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save SEO Settings"
          )}
        </Button>
      </div>
    </div>
  );
}
