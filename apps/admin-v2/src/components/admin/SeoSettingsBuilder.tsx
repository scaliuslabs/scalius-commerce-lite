import { useCallback } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CharacterCounter } from "@/components/ui/character-counter";
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
}

const defaultConfig: SeoConfig = {
  siteTitle: "",
  homepageTitle: "",
  homepageMetaDescription: "",
  robotsTxt: `User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`,
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
  };
};

const saveSeo = async (values: SeoConfig) => {
  await updateSeoSettings({
    data: values as unknown as SettingsPayload,
  });
};

export function SeoSettingsBuilder() {
  const { values, setValues, isLoading, isSaving, handleSubmit } =
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
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
