// src/components/admin/header-builder/HeaderBuilder.tsx
import { useState, useEffect, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { Loader2 } from "lucide-react";
import { nanoid } from "nanoid";
import { cn } from "@scalius/shared/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { saveHeaderConfig } from "~/lib/api-functions/settings";

import { BrandingSection } from "./BrandingSection";
import { TopBarSection } from "./TopBarSection";
import { ContactSection } from "./ContactSection";

import type { HeaderConfig, HeaderBuilderProps, NavigationItem, LogoConfig, FaviconConfig, SocialLink } from "./types";
import { defaultHeaderConfig } from "./types";

const SocialLinksSection = lazy(() =>
  import("./SocialLinksSection").then((module) => ({
    default: module.SocialLinksSection,
  })),
);

const NavigationSection = lazy(() =>
  import("./NavigationSection").then((module) => ({
    default: module.NavigationSection,
  })),
);

function HeaderSubtabSpinner() {
  return (
    <div className="flex items-center justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Migrate legacy config formats to the new structure
 */
function migrateConfig(config: unknown): HeaderConfig {
  const cfg = config as Record<string, unknown>;
  // Ensure navigation items have IDs and subMenus
  const ensureNavIds = (items: unknown[]): NavigationItem[] => {
    return (items || []).map((item) => {
      const it = item as Record<string, unknown>;
      return {
        ...it,
        id: (it.id as string) || nanoid(),
        subMenu: it.subMenu ? ensureNavIds(it.subMenu as unknown[]) : [],
      } as NavigationItem;
    });
  };

  // Migrate old social.facebook to social array
  let socialLinks: SocialLink[] = (cfg.social as SocialLink[]) || [];
  if (!Array.isArray(socialLinks)) {
    // Legacy format: { facebook: "url" }
    const socialObj = cfg.social as Record<string, unknown> | undefined;
    socialLinks = [];
    if (socialObj?.facebook) {
      socialLinks.push({
        id: nanoid(),
        label: "Facebook",
        url: socialObj.facebook as string,
      });
    }
  }

  const topBar = cfg.topBar as Record<string, unknown> | undefined;
  const contact = cfg.contact as Record<string, unknown> | undefined;
  return {
    topBar: {
      text: (topBar?.text as string) || "",
      isEnabled: (topBar?.isEnabled as boolean) ?? true,
    },
    logo: (cfg.logo as LogoConfig) || defaultHeaderConfig.logo,
    favicon: (cfg.favicon as FaviconConfig) || defaultHeaderConfig.favicon,
    contact: {
      phone: (contact?.phone as string) || "",
      text: (contact?.text as string) || "",
      isEnabled: (contact?.isEnabled as boolean) ?? true,
    },
    social: socialLinks,
    navigation: ensureNavIds(cfg.navigation as unknown[]),
  };
}

export function HeaderBuilder({ initialConfig, onSave }: HeaderBuilderProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<HeaderConfig>(() => {
    return migrateConfig(initialConfig || defaultHeaderConfig);
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

    if (!config.logo.src) {
      toast.error("Logo Required", { description: "Please select a logo before saving." });
      setActiveTab("branding");
      return;
    }

    setIsLoading(true);
    try {
      if (typeof onSave === "function") {
        await onSave(config);
      } else {
        await saveHeaderConfig({ data: config });
      }

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      toast.success("Success!", { description: "Header configuration saved successfully." });
    } catch (error: unknown) {
      console.error("Error saving header:", error);
      toast.error("Save Failed", { description: getServerFnError(error, "Failed to save header configuration.") });
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
            className="data-[state=active]:border-b-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 transition-none"
          >
            Branding
          </TabsTrigger>
          <TabsTrigger
            value="top-bar"
            className="data-[state=active]:border-b-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 transition-none"
          >
            Announcement
          </TabsTrigger>
          <TabsTrigger
            value="contact-social"
            className="data-[state=active]:border-b-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 transition-none"
          >
            Contact & Social
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="data-[state=active]:border-b-primary data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 pb-3 pt-2 transition-none"
          >
            Navigation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-0 p-1">
          <BrandingSection
            logo={config.logo}
            favicon={config.favicon}
            onLogoChange={(logo) => setConfig((prev) => ({ ...prev, logo }))}
            onFaviconChange={(favicon) =>
              setConfig((prev) => ({ ...prev, favicon }))
            }
          />
        </TabsContent>

        <TabsContent value="top-bar" className="mt-0 p-1">
          <TopBarSection
            topBar={config.topBar}
            onChange={(topBar) => setConfig((prev) => ({ ...prev, topBar }))}
          />
        </TabsContent>

        <TabsContent value="contact-social" className="mt-0 p-1 space-y-6">
          <ContactSection
            contact={config.contact}
            onChange={(contact) => setConfig((prev) => ({ ...prev, contact }))}
          />
          {activeTab === "contact-social" && (
            <Suspense fallback={<HeaderSubtabSpinner />}>
              <SocialLinksSection
                social={config.social}
                onChange={(social) =>
                  setConfig((prev) => ({ ...prev, social }))
                }
              />
            </Suspense>
          )}
        </TabsContent>

        <TabsContent value="navigation" className="mt-0 p-1">
          {activeTab === "navigation" && (
            <Suspense fallback={<HeaderSubtabSpinner />}>
              <NavigationSection
                navigation={config.navigation}
                onChange={(navigation) =>
                  setConfig((prev) => ({ ...prev, navigation }))
                }
                getStorefrontPath={getStorefrontPath}
              />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>

      <div className="flex justify-end pt-6 border-t border-border mt-8">
        <Button
          onClick={handleSave}
          disabled={isLoading || !config.logo.src}
          className="relative min-w-[140px]"
          size="lg"
        >
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-primary rounded-md">
              <Loader2 className="h-5 w-5 animate-spin text-primary-foreground" />
            </div>
          ) : null}
          <span className={cn(isLoading ? "opacity-0" : "opacity-100")}>
            Save Header Settings
          </span>
        </Button>
      </div>
    </div>
  );
}
