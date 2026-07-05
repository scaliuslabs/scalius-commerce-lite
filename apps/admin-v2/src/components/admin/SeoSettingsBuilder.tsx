import { useCallback } from "react";
import {
  Braces,
  Globe2,
  Loader2,
  Rss,
  Search,
  AlertCircle,
} from "lucide-react";
import {
  DEFAULT_SEO_DISCOVERY_SETTINGS,
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CharacterCounter } from "@/components/ui/character-counter";
import { Switch } from "../ui/switch";
import {
  getSeoSettings,
  type SettingsPayload,
  updateSeoSettings,
} from "@/lib/api-functions/settings";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";

interface SeoConfig {
  siteTitle: string;
  homepageTitle: string;
  homepageMetaDescription: string;
  robotsTxt: string;
  discovery: SeoDiscoverySettings;
}

const defaultConfig: SeoConfig = {
  siteTitle: "",
  homepageTitle: "",
  homepageMetaDescription: "",
  robotsTxt: `User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`,
  discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
};

const fetchSeo = async (): Promise<SeoConfig> => {
  const data = (await getSeoSettings()) as Record<string, unknown>;
  return {
    siteTitle: (data.siteTitle as string) || defaultConfig.siteTitle,
    homepageTitle: (data.homepageTitle as string) || defaultConfig.homepageTitle,
    homepageMetaDescription:
      (data.homepageMetaDescription as string) ||
      defaultConfig.homepageMetaDescription,
    robotsTxt: (data.robotsTxt as string) || defaultConfig.robotsTxt,
    discovery: normalizeSeoDiscoverySettings(data.discovery),
  };
};

const saveSeo = async (values: SeoConfig) => {
  await updateSeoSettings({
    data: values as unknown as SettingsPayload,
  });
};

export function SeoSettingsBuilder() {
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
      Section extends keyof SeoDiscoverySettings,
      Key extends keyof SeoDiscoverySettings[Section],
    >(
      section: Section,
      key: Key,
      value: SeoDiscoverySettings[Section][Key],
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

  const discoveryRows = [
    {
      icon: Globe2,
      title: "Sitemap",
      rows: [
        ["enabled", "Generate sitemap.xml"] as const,
        ["products", "Products"] as const,
        ["categories", "Categories"] as const,
        ["collections", "Collections"] as const,
        ["pages", "Pages"] as const,
      ],
    },
  ];

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
              Product Feed
            </div>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>Catalog feed XML</span>
              <Switch
                checked={values.discovery.feeds.productCatalogEnabled}
                onCheckedChange={(checked) =>
                  updateDiscovery("feeds", "productCatalogEnabled", checked)
                }
              />
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Controls `/api/facebook-feed.xml` for catalog sync tools.
            </p>
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
              JSON-LD
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
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="robots-txt">robots.txt Content</Label>
        <Textarea
          id="robots-txt"
          value={values.robotsTxt}
          onChange={(e) => updateField("robotsTxt", e.target.value)}
          placeholder={`User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`}
          rows={6}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Controls which pages search engine crawlers can access. Ensure your
          sitemap URL is included.
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
