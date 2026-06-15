// src/components/admin/footer-builder/FooterBuilder.tsx
import { useState, useEffect, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { saveFooterConfig } from "~/lib/api-functions/settings";

import { BrandingSection } from "./BrandingSection";
import { ContentSection } from "./ContentSection";

import type {
  FooterConfig,
  FooterBuilderProps,
  FooterMenu,
  SocialLink,
  LogoConfig,
} from "./types";
import { defaultFooterConfig } from "./types";

const NavigationMenusSection = lazy(() =>
  import("./NavigationMenusSection").then((module) => ({
    default: module.NavigationMenusSection,
  })),
);

const SocialLinksSection = lazy(() =>
  import("./SocialLinksSection").then((module) => ({
    default: module.SocialLinksSection,
  })),
);

function FooterSubtabSpinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Migrate legacy config formats to the new structure
 */
function migrateConfig(config: unknown): FooterConfig {
  const cfg = config as Record<string, unknown>;
  // Ensure menu items have IDs
  const ensureMenuIds = (menus: unknown[]): FooterMenu[] => {
    return (menus || []).map((menu) => {
      const m = menu as Record<string, unknown>;
      return {
        ...m,
        id: (m.id as string) || nanoid(),
        links: (m.links as unknown[]) || [],
      } as FooterMenu;
    });
  };

  // Migrate old social object format to array
  let socialLinks: SocialLink[] = [];
  if (Array.isArray(cfg.social)) {
    socialLinks = cfg.social.map((link: unknown) => {
      const l = link as Record<string, unknown>;
      return {
        id: (l.id as string) || nanoid(),
        label: (l.label as string) || (l.platform as string) || "",
        url: (l.url as string) || "",
        iconUrl: (l.iconUrl as string) || (l.icon as string),
      };
    });
  } else if (cfg.social && typeof cfg.social === "object") {
    // Legacy format: { facebook: "url", twitter: "url" }
    Object.entries(cfg.social as Record<string, unknown>).forEach(([platform, url]) => {
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
    logo: (cfg.logo as LogoConfig) || defaultFooterConfig.logo,
    tagline: (cfg.tagline as string) || "",
    description: (cfg.description as string) || "",
    copyrightText: (cfg.copyrightText as string) || defaultFooterConfig.copyrightText,
    menus: ensureMenuIds(cfg.menus as unknown[]),
    social: socialLinks,
  };
}

export function FooterBuilder({ initialConfig, onSave }: FooterBuilderProps) {
  const queryClient = useQueryClient();

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
        await saveFooterConfig({ data: config });
      }

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      toast.success("Saved", { description: "Footer configuration updated." });
    } catch (error: unknown) {
      console.error("Error saving footer:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to save.") });
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
          {activeTab === "navigation" && (
            <Suspense fallback={<FooterSubtabSpinner />}>
              <NavigationMenusSection
                menus={config.menus}
                onChange={(menus) =>
                  setConfig((prev) => ({ ...prev, menus }))
                }
              />
            </Suspense>
          )}
        </TabsContent>

        <TabsContent value="social" className="space-y-6">
          {activeTab === "social" && (
            <Suspense fallback={<FooterSubtabSpinner />}>
              <SocialLinksSection
                social={config.social}
                onChange={(social) =>
                  setConfig((prev) => ({ ...prev, social }))
                }
              />
            </Suspense>
          )}
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
