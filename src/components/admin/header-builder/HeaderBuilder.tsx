// src/components/admin/header-builder/HeaderBuilder.tsx
import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { Loader2, CheckCircle2 } from "lucide-react";
import { nanoid } from "nanoid";
import { cn } from "@/lib/utils";

import { BrandingSection } from "./BrandingSection";
import { TopBarSection } from "./TopBarSection";
import { ContactSection } from "./ContactSection";
import { SocialLinksSection } from "./SocialLinksSection";
import { NavigationSection } from "./NavigationSection";

import type { HeaderConfig, HeaderBuilderProps, NavigationItem } from "./types";
import { defaultHeaderConfig } from "./types";

/**
 * Migrate legacy config formats to the new structure
 */
function migrateConfig(config: any): HeaderConfig {
  // Ensure navigation items have IDs and subMenus
  const ensureNavIds = (items: any[]): NavigationItem[] => {
    return (items || []).map((item) => ({
      ...item,
      id: item.id || nanoid(),
      subMenu: item.subMenu ? ensureNavIds(item.subMenu) : [],
    }));
  };

  // Migrate old social.facebook to social array
  let socialLinks = config.social || [];
  if (!Array.isArray(socialLinks)) {
    // Legacy format: { facebook: "url" }
    socialLinks = [];
    if (config.social?.facebook) {
      socialLinks.push({
        id: nanoid(),
        label: "Facebook",
        url: config.social.facebook,
      });
    }
  }

  return {
    topBar: {
      text: config.topBar?.text || "",
      isEnabled: config.topBar?.isEnabled ?? true,
    },
    logo: config.logo || defaultHeaderConfig.logo,
    favicon: config.favicon || defaultHeaderConfig.favicon,
    contact: {
      phone: config.contact?.phone || "",
      text: config.contact?.text || "",
      isEnabled: config.contact?.isEnabled ?? true,
    },
    social: socialLinks,
    navigation: ensureNavIds(config.navigation),
  };
}

export function HeaderBuilder({ initialConfig, onSave }: HeaderBuilderProps) {
  const { toast } = useToast();
  const { getStorefrontPath } = useStorefrontUrl();

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
      toast({
        title: "Logo Required",
        description: "Please select a logo before saving.",
        variant: "destructive",
      });
      setActiveTab("branding");
      return;
    }

    setIsLoading(true);
    try {
      if (typeof onSave === "function") {
        await onSave(config);
      } else {
        const apiUrl =
          typeof onSave === "string" ? onSave : "/api/settings/header";
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(
            error.details || "Failed to save header configuration",
          );
        }
      }

      toast({
        title: "Success!",
        description: "Header configuration saved successfully.",
        variant: "default",
        action: <CheckCircle2 className="h-5 w-5 text-green-500" />,
      });
    } catch (error) {
      console.error("Error saving header:", error);
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
          <SocialLinksSection
            social={config.social}
            onChange={(social) => setConfig((prev) => ({ ...prev, social }))}
          />
        </TabsContent>

        <TabsContent value="navigation" className="mt-0 p-1">
          <NavigationSection
            navigation={config.navigation}
            onChange={(navigation) =>
              setConfig((prev) => ({ ...prev, navigation }))
            }
            getStorefrontPath={getStorefrontPath}
          />
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
