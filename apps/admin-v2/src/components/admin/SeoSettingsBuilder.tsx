import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Braces,
  Globe2,
  Loader2,
  Rss,
  Search,
  AlertCircle,
  ChevronDown,
  RotateCcw,
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
import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";

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
  const discovery = normalizeSeoDiscoverySettingsWithReturnPolicy(
    data.discovery,
  );
  const returnPolicySource =
    readReturnPolicy(data.discovery) ??
    data.returnPolicy ??
    discovery.returnPolicy;

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
    isLoaded,
    isLoadError,
    loadError,
    isSaving,
    isDirty,
    reset,
    handleSubmit,
    refetch,
  } = useSettingsForm<SeoConfig>({
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
        ["articles", "Articles"] as const,
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

  const hasCustomRobotsRules =
    values.robotsTxt.trim() !== defaultConfig.robotsTxt.trim();

  return (
    <>
      <UnsavedChangesGuard isDirty={isDirty} isSubmitting={isSaving} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="order-last min-w-0 xl:sticky xl:top-4">
          <SeoDiscoveryStatusCard
            discovery={values.discovery}
            robotsTxt={values.robotsTxt}
            businessIdentity={businessIdentity}
            hasStoreLogo={hasStoreLogo}
          />
        </aside>

        <div className="min-w-0 space-y-5">
        <section className="overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <Search className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Search appearance</h3>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Defaults for the homepage and pages without their own search
                preview.
              </p>
            </div>
          </div>
          <div className="space-y-4 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="site-title">Fallback site title</Label>
                <Input
                  id="site-title"
                  value={values.siteTitle}
                  onChange={(e) => updateField("siteTitle", e.target.value)}
                  placeholder="Your Awesome Store - Gadgets, Gizmos, and More"
                  className="min-h-11 sm:min-h-9"
                />
                {values.siteTitle && (
                  <CharacterCounter
                    current={values.siteTitle.length}
                    recommended={60}
                    max={70}
                  />
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  Used only when a public resource has no specific title.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="homepage-title">Homepage title</Label>
                <Input
                  id="homepage-title"
                  value={values.homepageTitle}
                  onChange={(e) => updateField("homepageTitle", e.target.value)}
                  placeholder="Welcome to Your Awesome Store | Shop Online"
                  className="min-h-11 sm:min-h-9"
                />
                {values.homepageTitle && (
                  <CharacterCounter
                    current={values.homepageTitle.length}
                    recommended={60}
                    max={70}
                  />
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  Shown in the homepage browser tab and search result.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="homepage-meta-description">
                Homepage search summary
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

            <p className="text-xs leading-5 text-muted-foreground">
              Describe the store plainly; search engines may choose different
              text when it better matches a buyer’s query.
            </p>
          </div>
        </section>

        <div className="rounded-lg border border-border">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold">Discovery controls</h3>
              <p className="text-xs text-muted-foreground">
                Choose public discovery files and structured data.
              </p>
            </div>
          </div>

          <div className="grid gap-0 md:grid-cols-2">
            {discoveryRows.map((section) => (
              <div
                key={section.title}
                className="border-b border-border p-4 md:border-r"
              >
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
                Product catalog feed
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
                {values.discovery.feeds.productCatalogEnabled ? (
                  <>
                    <label className="flex items-center justify-between gap-4 text-sm">
                      <span>Include sold-out items</span>
                      <Switch
                        checked={
                          values.discovery.feeds.includeUnavailableProducts
                        }
                        onCheckedChange={(checked) =>
                          updateDiscovery(
                            "feeds",
                            "includeUnavailableProducts",
                            checked,
                          )
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
                    <SelectTrigger
                      id="feed-variant-strategy"
                      className="min-h-11 sm:min-h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="variants">
                        SKU / variant rows
                      </SelectItem>
                      <SelectItem value="products">Product rows</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Use SKU / variant rows for products with options. Use
                    product rows only when a catalog tool should receive one row
                    per product.
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
                    className="min-h-11 sm:min-h-9"
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
                      updateDiscovery(
                        "feeds",
                        "description",
                        event.target.value,
                      )
                    }
                    placeholder="Complete product catalog for feed tools"
                    className="min-h-11 sm:min-h-9"
                  />
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Provides Google-compatible XML and a Meta compatibility
                      feed.
                    </p>
                  </>
                ) : null}
              </div>
            </div>

            <div className="border-b border-border p-4 md:border-r">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Search className="h-4 w-4 text-muted-foreground" />
                UCP catalog discovery
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Read-only catalog search for shopping agents. Requires an HTTPS
                Store URL.
              </p>
            </div>

            <div className="border-b border-border p-4">
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

            <div className="p-4 md:col-span-2">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Braces className="h-4 w-4 text-muted-foreground" />
                Structured data
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
                      updateDiscovery(
                        "structuredData",
                        "websiteSearch",
                        checked,
                      )
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
                      updateDiscovery(
                        "structuredData",
                        "productGroups",
                        checked,
                      )
                    }
                  />
                </label>
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                    Offer shipping schema
                  </span>
                  <Switch
                    checked={
                      values.discovery.structuredData.offerShippingDetails
                    }
                    onCheckedChange={(checked) =>
                      updateDiscovery(
                        "structuredData",
                        "offerShippingDetails",
                        checked,
                      )
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
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span>Article schema</span>
                  <Switch
                    checked={values.discovery.structuredData.articles}
                    onCheckedChange={(checked) =>
                      updateDiscovery("structuredData", "articles", checked)
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
                      Return policy schema
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Publishes the saved policy to search engines. It does not
                      change order handling.
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

              {returnPolicy.enabled ? (
                <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
                <div className="grid min-w-0 gap-2">
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
                    className="min-h-11 uppercase sm:min-h-9"
                  />
                </div>

                <div className="grid min-w-0 gap-2">
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
                            ? (returnPolicy.returnWindowDays ??
                              DEFAULT_RETURN_WINDOW_DAYS)
                            : null,
                      });
                    }}
                  >
                    <SelectTrigger
                      id="return-policy-category"
                      className="min-h-11 min-w-0 sm:min-h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="finite">
                        Finite return window
                      </SelectItem>
                      <SelectItem value="unlimited">
                        Unlimited returns
                      </SelectItem>
                      <SelectItem value="no_returns">No returns</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {isFiniteReturnPolicy ? (
                  <div className="grid min-w-0 gap-2">
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
                      className="min-h-11 sm:min-h-9"
                    />
                  </div>
                ) : null}

                <div className="grid min-w-0 gap-2">
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
                    <SelectTrigger
                      id="return-policy-fees"
                      className="min-h-11 min-w-0 sm:min-h-9"
                    >
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

                <div className="grid min-w-0 gap-2">
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
                    <SelectTrigger
                      id="return-policy-method"
                      className="min-h-11 min-w-0 sm:min-h-9"
                    >
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

                <div className="grid min-w-0 gap-2 md:col-span-2">
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
                      updateReturnPolicy({
                        policyUrl: event.target.value.trim(),
                      })
                    }
                    placeholder="/returns"
                    className="min-h-11 sm:min-h-9"
                  />
                  {returnPolicyUrlInvalid ? (
                    <p className="text-xs leading-5 text-amber-700">
                      Use a same-origin path like /returns or an absolute
                      http(s) URL. Invalid policy URLs are omitted on save.
                    </p>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Optional. Leave blank until the public return policy page
                      is ready.
                    </p>
                  )}
                </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <section className="overflow-hidden rounded-lg border border-border bg-background">
          <details className="group" open={hasCustomRobotsRules}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:content-none">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">
                  Advanced robots.txt rules
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {hasCustomRobotsRules
                    ? "Custom crawler rules are active."
                    : "Optional crawler allow and disallow rules."}
                </p>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-2 border-t border-border p-4">
              <Label htmlFor="robots-txt">Crawler rules</Label>
              <Textarea
                id="robots-txt"
                value={values.robotsTxt}
                onChange={(e) => updateField("robotsTxt", e.target.value)}
                placeholder={`User-agent: *\nAllow: /`}
                rows={6}
                className="font-mono text-sm"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Sitemap URLs are managed by the switch above.
              </p>
            </div>
          </details>
        </section>

        {isDirty ? (
          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={reset}
              disabled={isSaving}
              className="min-h-11 sm:min-h-9"
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSaving || !isLoaded}
              className="min-h-11 min-w-[120px] sm:min-h-9"
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save discovery settings"
              )}
            </Button>
          </div>
        ) : null}
        </div>
      </div>
    </>
  );
}
