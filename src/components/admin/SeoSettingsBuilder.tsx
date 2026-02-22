import { useState, useEffect } from "react";
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
  robotsTxt: `User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`,
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
          <p className="text-xs text-muted-foreground">
            Default title for your site. Keep it concise and descriptive.
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
          value={config.robotsTxt}
          onChange={(e) =>
            setConfig({ ...config, robotsTxt: e.target.value })
          }
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
          onClick={handleSave}
          disabled={isLoading}
          className="min-w-[120px]"
        >
          {isLoading ? (
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
