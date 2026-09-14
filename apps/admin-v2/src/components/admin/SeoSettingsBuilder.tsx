import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, Truck, Undo2 } from "lucide-react";
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
import { CharacterCounter } from "~/components/ui/character-counter";
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
} from "~/lib/seo-discovery-status";
import {
  getBusinessSettings,
  getSeoSettings,
  updateSeoSettings,
  type UpdateSeoSettingsInput,
} from "~/lib/api-functions/settings";
import { generalSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { queryKeys } from "~/lib/query-keys";
import {
  ContextualSaveBar,
  FieldError,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
} from "~/components/admin/shell";

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

/** Sitemap sections, in the order runtime lists them. */
const SITEMAP_ROWS = [
  ["enabled", "Generate sitemap.xml"],
  ["staticPages", "Home + search"],
  ["products", "Products"],
  ["categories", "Categories"],
  ["collections", "Collections"],
  ["pages", "Pages"],
  ["articles", "Articles"],
] as const satisfies ReadonlyArray<
  readonly [keyof SeoDiscoverySettingsWithReturnPolicy["sitemap"], string]
>;

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
      <SkeletonPage
        showHeader={false}
        sections={3}
        rowsPerSection={3}
        label="Loading SEO settings"
      />
    );
  }

  if (isLoadError) {
    const message =
      loadError instanceof Error && loadError.message
        ? loadError.message
        : "SEO settings could not be loaded. Existing search settings were not changed.";

    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>SEO settings unavailable</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{message}</p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={refetch}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const hasCustomRobotsRules =
    values.robotsTxt.trim() !== defaultConfig.robotsTxt.trim();

  return (
    <div>
      <ContextualSaveBar
        isDirty={isDirty || isSaving}
        saving={isSaving}
        saveDisabled={!isLoaded}
        saveDisabledReason="Reload the SEO settings before saving."
        saveLabel="Save discovery settings"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={reset}
        onSave={() => void handleSubmit()}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="order-last min-w-0 xl:sticky xl:top-4">
          <SeoDiscoveryStatusCard
            discovery={values.discovery}
            robotsTxt={values.robotsTxt}
            businessIdentity={businessIdentity}
            hasStoreLogo={hasStoreLogo}
          />
        </aside>

        <div className="min-w-0 space-y-6">
          <SettingsSection
            title="Search appearance"
            description="Fills the browser tab and search result when a public page has no title or summary of its own."
          >
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="site-title">Fallback site title</Label>
                  <Input
                    id="site-title"
                    value={values.siteTitle}
                    onChange={(e) => updateField("siteTitle", e.target.value)}
                    placeholder="Your Awesome Store - Gadgets, Gizmos, and More"
                    aria-describedby="site-title-help"
                    className="min-h-11 sm:min-h-9"
                  />
                  {values.siteTitle && (
                    <CharacterCounter
                      current={values.siteTitle.length}
                      recommended={60}
                      max={70}
                    />
                  )}
                  <InlineHelp id="site-title-help">
                    Used only when a public resource has no specific title.
                  </InlineHelp>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="homepage-title">Homepage title</Label>
                  <Input
                    id="homepage-title"
                    value={values.homepageTitle}
                    onChange={(e) => updateField("homepageTitle", e.target.value)}
                    placeholder="Welcome to Your Awesome Store | Shop Online"
                    aria-describedby="homepage-title-help"
                    className="min-h-11 sm:min-h-9"
                  />
                  {values.homepageTitle && (
                    <CharacterCounter
                      current={values.homepageTitle.length}
                      recommended={60}
                      max={70}
                    />
                  )}
                  <InlineHelp id="homepage-title-help">
                    Shown in the homepage browser tab and search result.
                  </InlineHelp>
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
                  aria-describedby="homepage-meta-description-help"
                  rows={3}
                />
                {values.homepageMetaDescription && (
                  <CharacterCounter
                    current={values.homepageMetaDescription.length}
                    recommended={160}
                    max={200}
                  />
                )}
                <InlineHelp id="homepage-meta-description-help">
                  Describe the store plainly; search engines may choose different
                  text when it better matches a buyer’s query.
                </InlineHelp>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Sitemap"
            description="Chooses which public sections runtime lists in sitemap.xml."
          >
            <div className="space-y-3">
              {SITEMAP_ROWS.map(([key, label]) => (
                <label
                  key={key}
                  className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9"
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
          </SettingsSection>

          <SettingsSection
            title="Product catalog feed"
            description="Publishes a Google-compatible catalog feed and a Meta compatibility feed."
          >
            <div className="space-y-3">
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
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
                  <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
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
                    <Label htmlFor="feed-variant-strategy">
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
                        aria-describedby="feed-variant-strategy-help"
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
                    <InlineHelp id="feed-variant-strategy-help">
                      Use SKU / variant rows for products with options. Use
                      product rows only when a catalog tool should receive one row
                      per product.
                    </InlineHelp>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="feed-title">Feed title</Label>
                    <Input
                      id="feed-title"
                      value={values.discovery.feeds.title}
                      onChange={(event) =>
                        updateDiscovery("feeds", "title", event.target.value)
                      }
                      placeholder="Product Catalog"
                      aria-describedby="feed-title-help"
                      className="min-h-11 sm:min-h-9"
                    />
                    <InlineHelp id="feed-title-help">
                      Names the catalog inside the generated feed XML.
                    </InlineHelp>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="feed-description">Feed description</Label>
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
                      aria-describedby="feed-description-help"
                      className="min-h-11 sm:min-h-9"
                    />
                    <InlineHelp id="feed-description-help">
                      Describes the catalog inside the generated feed XML.
                    </InlineHelp>
                  </div>
                </>
              ) : null}
            </div>
          </SettingsSection>

          <SettingsSection
            title="UCP catalog discovery"
            description="Read-only catalog search for shopping agents. Requires an HTTPS Store URL."
          >
            <InlineHelp>
              Runtime publishes catalog search and lookup only. Checkout, cart,
              and payment are never advertised.
            </InlineHelp>
          </SettingsSection>

          <SettingsSection
            title="robots.txt"
            description="Controls what crawlers read before they fetch any page."
          >
            <div className="space-y-4">
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Advertise sitemap URL</span>
                <Switch
                  checked={values.discovery.robots.advertiseSitemap}
                  onCheckedChange={(checked) =>
                    updateDiscovery("robots", "advertiseSitemap", checked)
                  }
                />
              </label>

              <details className="group rounded-md border" open={hasCustomRobotsRules}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:content-none">
                  <div className="min-w-0">
                    <span className="text-sm font-medium">
                      Advanced robots.txt rules
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {hasCustomRobotsRules
                        ? "Custom crawler rules are active."
                        : "Optional crawler allow and disallow rules."}
                    </p>
                  </div>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <div className="space-y-2 border-t p-3">
                  <Label htmlFor="robots-txt">Crawler rules</Label>
                  <Textarea
                    id="robots-txt"
                    value={values.robotsTxt}
                    onChange={(e) => updateField("robotsTxt", e.target.value)}
                    placeholder={`User-agent: *\nAllow: /`}
                    aria-describedby="robots-txt-help"
                    rows={6}
                    className="font-mono text-sm"
                  />
                  <InlineHelp id="robots-txt-help">
                    Sitemap URLs are managed by the switch above.
                  </InlineHelp>
                </div>
              </details>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Structured data"
            description="Each switch decides whether runtime may emit that schema; page prerequisites still apply."
          >
            <div className="space-y-3">
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Organization schema</span>
                <Switch
                  checked={values.discovery.structuredData.organization}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "organization", checked)
                  }
                />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
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
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Product schema</span>
                <Switch
                  checked={values.discovery.structuredData.products}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "products", checked)
                  }
                />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
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
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span className="inline-flex items-center gap-2">
                  <Truck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
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
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Breadcrumb schema</span>
                <Switch
                  checked={values.discovery.structuredData.breadcrumbs}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "breadcrumbs", checked)
                  }
                />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Collection schema</span>
                <Switch
                  checked={values.discovery.structuredData.collections}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "collections", checked)
                  }
                />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Article schema</span>
                <Switch
                  checked={values.discovery.structuredData.articles}
                  onCheckedChange={(checked) =>
                    updateDiscovery("structuredData", "articles", checked)
                  }
                />
              </label>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Return policy schema"
            description="Publishes the saved policy to search engines. It does not change order handling."
          >
            <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
              <span className="inline-flex items-center gap-2">
                <Undo2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Emit return policy schema
              </span>
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

            {returnPolicy.enabled ? (
              <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="return-policy-country">Country</Label>
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
                  <Label htmlFor="return-policy-category">
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
                    <Label htmlFor="return-window-days">
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
                  <Label htmlFor="return-policy-fees">Return fees</Label>
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
                  <Label htmlFor="return-policy-method">Return method</Label>
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
                  <Label htmlFor="return-policy-url">Policy URL</Label>
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
                    aria-invalid={returnPolicyUrlInvalid}
                    aria-describedby="return-policy-url-help"
                    className="min-h-11 sm:min-h-9"
                  />
                  {returnPolicyUrlInvalid ? (
                    <FieldError id="return-policy-url-help">
                      Use a same-origin path like /returns or an absolute
                      http(s) URL. Invalid policy URLs are omitted on save.
                    </FieldError>
                  ) : (
                    <InlineHelp id="return-policy-url-help">
                      Optional. Leave blank until the public return policy page
                      is ready.
                    </InlineHelp>
                  )}
                </div>
              </div>
            ) : null}
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
