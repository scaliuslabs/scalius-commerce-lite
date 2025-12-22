import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CharacterCounter } from "@/components/ui/character-counter";

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
  robotsTxt: `User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`, // Default robots.txt
};

export function SeoSettingsBuilder() {
  const { toast } = useToast();
  const [config, setConfig] = useState<SeoConfig>(defaultConfig);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);

  useEffect(() => {
    const fetchSeoConfig = async () => {
      setIsFetching(true);
      try {
        const response = await fetch("/api/settings/seo");
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.details || "Failed to fetch SEO settings");
        }
        const data = await response.json();
        setConfig({
          siteTitle: data.siteTitle || defaultConfig.siteTitle,
          homepageTitle: data.homepageTitle || defaultConfig.homepageTitle,
          homepageMetaDescription:
            data.homepageMetaDescription ||
            defaultConfig.homepageMetaDescription,
          robotsTxt: data.robotsTxt || defaultConfig.robotsTxt,
        });
      } catch (error) {
        console.error("Error fetching SEO config:", error);
        toast({
          title: "Fetch Error",
          description:
            error instanceof Error
              ? error.message
              : "Could not load SEO settings.",
          variant: "destructive",
        });
        // Fallback to default config if fetch fails
        setConfig(defaultConfig);
      } finally {
        setIsFetching(false);
      }
    };
    fetchSeoConfig();
  }, [toast]);

  const handleSave = async () => {
    if (isLoading) return;
    setIsLoading(true);

    try {
      const response = await fetch("/api/settings/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.details || "Failed to save SEO configuration");
      }

      toast({
        title: "Success!",
        description: "SEO settings saved successfully.",
        variant: "default",
        action: <CheckCircle2 className="h-5 w-5 text-green-500" />,
      });
    } catch (error) {
      console.error("Error saving SEO settings:", error);
      toast({
        title: "Save Failed",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isFetching) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="ml-3 text-muted-foreground">Loading SEO settings...</p>
      </div>
    );
  }

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <CardTitle>SEO Settings</CardTitle>
        <CardDescription>
          Configure your site's general SEO properties and robots.txt content.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="site-title">Global Site Title</Label>
          <Input
            id="site-title"
            value={config.siteTitle}
            onChange={(e) =>
              setConfig({ ...config, siteTitle: e.target.value })
            }
            placeholder="Your Awesome Store - Gadgets, Gizmos, and More"
          />
          {config.siteTitle && (
            <CharacterCounter
              current={config.siteTitle.length}
              recommended={60}
              max={70}
            />
          )}
          <p className="text-sm text-muted-foreground">
            The default title for your site, used if a page-specific title isn't
            set. Keep it concise and descriptive.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="homepage-title">Homepage Title</Label>
          <Input
            id="homepage-title"
            value={config.homepageTitle}
            onChange={(e) =>
              setConfig({ ...config, homepageTitle: e.target.value })
            }
            placeholder="Welcome to Your Awesome Store | Shop Online"
          />
          {config.homepageTitle && (
            <CharacterCounter
              current={config.homepageTitle.length}
              recommended={60}
              max={70}
            />
          )}
          <p className="text-sm text-muted-foreground">
            The specific title for your homepage (e.g., displayed in browser
            tabs and search results for your main page).
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="homepage-meta-description">
            Homepage Meta Description
          </Label>
          <Textarea
            id="homepage-meta-description"
            value={config.homepageMetaDescription}
            onChange={(e) =>
              setConfig({ ...config, homepageMetaDescription: e.target.value })
            }
            placeholder="Describe your homepage in a way that attracts users from search results."
            rows={3}
          />
          {config.homepageMetaDescription && (
            <CharacterCounter
              current={config.homepageMetaDescription.length}
              recommended={160}
              max={200}
            />
          )}
          <p className="text-sm text-muted-foreground">
            The meta description for your homepage. Recommended: 150-160
            characters for optimal SEO.
          </p>
        </div>

        <Alert variant="default">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Title Usage</AlertTitle>
          <AlertDescription>
            These titles are used as defaults. Individual pages, products, and
            categories might have their own specific meta titles which can
            override these global settings for more targeted SEO.
          </AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label htmlFor="robots-txt">robots.txt Content</Label>
          <Textarea
            id="robots-txt"
            value={config.robotsTxt}
            onChange={(e) =>
              setConfig({ ...config, robotsTxt: e.target.value })
            }
            placeholder={`User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`}
            rows={8}
            className="font-mono text-sm"
          />
          <p className="text-sm text-muted-foreground">
            Manage the content of your robots.txt file. This tells search engine
            crawlers which pages or files the crawler can or can't request from
            your site. Ensure your sitemap URL is correctly specified if you
            have one.
          </p>
        </div>

        <div className="flex justify-end pt-4 border-t border-border">
          <Button
            onClick={handleSave}
            disabled={isLoading}
            className="relative min-w-[120px]"
          >
            {isLoading ? (
              <div className="absolute inset-0 flex items-center justify-center bg-primary rounded-md">
                <Loader2 className="h-5 w-5 animate-spin text-primary-foreground" />
              </div>
            ) : null}
            <span className={isLoading ? "opacity-0" : "opacity-100"}>
              Save SEO Settings
            </span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
