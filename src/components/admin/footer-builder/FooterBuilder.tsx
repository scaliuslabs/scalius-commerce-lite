// src/components/admin/footer-builder/FooterBuilder.tsx
import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2 } from "lucide-react";
import { nanoid } from "nanoid";

import { BrandingSection } from "./BrandingSection";
import { ContentSection } from "./ContentSection";
import { NavigationMenusSection } from "./NavigationMenusSection";
import { SocialLinksSection } from "./SocialLinksSection";

import type {
  FooterConfig,
  FooterBuilderProps,
  FooterMenu,
  SocialLink,
} from "./types";
import { defaultFooterConfig } from "./types";

/**
 * Migrate legacy config formats to the new structure
 */
function migrateConfig(config: any): FooterConfig {
  // Ensure menu items have IDs
  const ensureMenuIds = (menus: any[]): FooterMenu[] => {
    return (menus || []).map((menu) => ({
      ...menu,
      id: menu.id || nanoid(),
      links: menu.links || [],
    }));
  };

  // Migrate old social object format to array
  let socialLinks: SocialLink[] = [];
  if (Array.isArray(config.social)) {
    socialLinks = config.social.map((link: any) => ({
      id: link.id || nanoid(),
      label: link.label || link.platform || "",
      url: link.url || "",
      iconUrl: link.iconUrl || link.icon,
    }));
  } else if (config.social && typeof config.social === "object") {
    // Legacy format: { facebook: "url", twitter: "url" }
    Object.entries(config.social).forEach(([platform, url]) => {
      if (url && typeof url === "string") {
        socialLinks.push({
          id: nanoid(),
          label: platform.charAt(0).toUpperCase() + platform.slice(1),
          url: url,
        });
      }
    });
  }

  return {
    logo: config.logo || defaultFooterConfig.logo,
    tagline: config.tagline || "",
    description: config.description || "",
    copyrightText: config.copyrightText || defaultFooterConfig.copyrightText,
    menus: ensureMenuIds(config.menus),
    social: socialLinks,
  };
}

export function FooterBuilder({ initialConfig, onSave }: FooterBuilderProps) {
  const { toast } = useToast();

  const [config, setConfig] = useState<FooterConfig>(() => {
    return migrateConfig(initialConfig || defaultFooterConfig);
  });
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("branding");

  // Update config when initialConfig changes
  useEffect(() => {
    if (initialConfig) {
      setConfig(migrateConfig(initialConfig));
    }
  }, [initialConfig]);

  const handleSave = async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      if (typeof onSave === "function") {
        await onSave(config);
      } else {
        const apiUrl =
          typeof onSave === "string" ? onSave : "/api/settings/footer";
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(
            error.details || "Failed to save footer configuration",
          );
        }
      }

      toast({
        title: "Saved",
        description: "Footer configuration updated.",
        action: <CheckCircle2 className="h-5 w-5 text-green-500" />,
      });
    } catch (error) {
      console.error("Error saving footer:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="border-b border-border w-full justify-start rounded-none bg-transparent p-0 mb-6">
          <TabsTrigger
            value="branding"
            className="rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 data-[state=active]:border-b-primary"
          >
            Branding & Text
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 data-[state=active]:border-b-primary"
          >
            Navigation Menus
          </TabsTrigger>
          <TabsTrigger
            value="social"
            className="rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 data-[state=active]:border-b-primary"
          >
            Social Media
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="space-y-6">
          <BrandingSection
            logo={config.logo}
            onLogoChange={(logo) => setConfig((prev) => ({ ...prev, logo }))}
          />
          <ContentSection
            tagline={config.tagline}
            description={config.description}
            copyrightText={config.copyrightText}
            onTaglineChange={(tagline) =>
              setConfig((prev) => ({ ...prev, tagline }))
            }
            onDescriptionChange={(description) =>
              setConfig((prev) => ({ ...prev, description }))
            }
            onCopyrightChange={(copyrightText) =>
              setConfig((prev) => ({ ...prev, copyrightText }))
            }
          />
        </TabsContent>

        <TabsContent value="navigation" className="space-y-6">
          <NavigationMenusSection
            menus={config.menus}
            onChange={(menus) => setConfig((prev) => ({ ...prev, menus }))}
          />
        </TabsContent>

        <TabsContent value="social" className="space-y-6">
          <SocialLinksSection
            social={config.social}
            onChange={(social) => setConfig((prev) => ({ ...prev, social }))}
          />
        </TabsContent>
      </Tabs>

      <div className="flex justify-end pt-4 border-t">
        <Button onClick={handleSave} disabled={isLoading} size="lg">
          {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save Footer
        </Button>
      </div>
    </div>
  );
}
