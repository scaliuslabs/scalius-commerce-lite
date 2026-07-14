// src/components/admin/footer-builder/FooterBuilder.tsx
import { useState, lazy, Suspense, useEffect, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { Image as ImageIcon, LayoutList, Loader2, RotateCcw, Share2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@scalius/shared/utils";
import { stripNavigationResolution } from "@scalius/shared/navigation-target";
import { getServerFnError } from "~/lib/api-helpers";
import { saveFooterConfig } from "~/lib/api-functions/settings";
import { useConfigDraft } from "~/components/admin/shared/use-config-draft";
import { NavigationConfigReadinessNotice } from "~/components/admin/settings/NavigationConfigReadinessNotice";

import { BrandingSection } from "./BrandingSection";
import { ContentSection } from "./ContentSection";

import type {
  FooterConfig,
  FooterBuilderPanel,
  FooterBuilderProps,
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

export function normalizeFooterConfig(config?: FooterConfig | null): FooterConfig {
  if (!config) return defaultFooterConfig;
  return {
    logo: { ...defaultFooterConfig.logo, ...config.logo },
    tagline: config.tagline ?? "",
    description: config.description ?? "",
    copyrightText: config.copyrightText ?? "",
    menus: Array.isArray(config.menus) ? config.menus : [],
    social: Array.isArray(config.social) ? config.social : [],
  };
}

export function FooterBuilder({
  activePanel,
  initialConfig,
  readiness,
  onPanelChange,
  onSave,
}: FooterBuilderProps) {
  const queryClient = useQueryClient();

  const normalizedInitialConfig = useMemo(
    () => normalizeFooterConfig(initialConfig),
    [initialConfig],
  );
  const { config, setConfig, isDirty, discard, markSaved } =
    useConfigDraft(normalizedInitialConfig);
  const [isLoading, setIsLoading] = useState(false);
  const [internalActivePanel, setInternalActivePanel] =
    useState<FooterBuilderPanel>("branding");
  const activeTab = activePanel ?? internalActivePanel;
  const [navigationEditorEpoch, setNavigationEditorEpoch] = useState(0);
  const [legacyFormatSaved, setLegacyFormatSaved] = useState(false);
  const navigationSaveRequired =
    readiness?.state === "legacy_normalized" && !legacyFormatSaved;
  const navigationInvalid = readiness?.state === "invalid";

  useEffect(() => {
    setLegacyFormatSaved(false);
  }, [readiness?.state]);

  const handlePanelChange = (panel: string) => {
    const nextPanel = panel as FooterBuilderPanel;
    if (activePanel === undefined) setInternalActivePanel(nextPanel);
    onPanelChange?.(nextPanel);
  };

  const handleDiscard = () => {
    discard();
    setNavigationEditorEpoch((current) => current + 1);
  };

  const handleSave = async () => {
    if (isLoading || navigationInvalid) return;

    setIsLoading(true);
    try {
      const storedConfig: FooterConfig = {
        ...config,
        menus: config.menus.map((menu) => ({
          ...menu,
          links: menu.links.map(stripNavigationResolution),
        })),
      };
      if (typeof onSave === "function") {
        await onSave(storedConfig);
      } else {
        await saveFooterConfig({ data: storedConfig });
      }

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      markSaved();
      if (readiness?.state === "legacy_normalized") setLegacyFormatSaved(true);
      setNavigationEditorEpoch((current) => current + 1);
      toast.success("Footer saved", { description: "Storefront layout is refreshing." });
    } catch (error: unknown) {
      console.error("Error saving footer:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to save.") });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Storefront footer</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Keep brand context, help links, and social destinations easy to scan.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              navigationInvalid
                ? "bg-destructive"
                : isDirty || navigationSaveRequired
                  ? "bg-amber-500"
                  : "bg-emerald-500",
            )}
          />
          {navigationInvalid
            ? "Editing locked"
            : navigationSaveRequired
              ? "Save required"
              : isDirty
                ? "Unsaved changes"
                : "All changes saved"}
        </div>
      </div>

      <NavigationConfigReadinessNotice
        section="footer"
        readiness={legacyFormatSaved ? { state: "ready" } : readiness}
      />

      {!navigationInvalid ? <Tabs value={activeTab} onValueChange={handlePanelChange} className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border bg-muted/20 p-1 lg:sticky lg:top-20 lg:flex-col lg:self-start">
          <TabsTrigger
            value="branding"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <ImageIcon className="h-4 w-4" />
            Branding & Text
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <LayoutList className="h-4 w-4" />
            Navigation Menus
          </TabsTrigger>
          <TabsTrigger
            value="social"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <Share2 className="h-4 w-4" />
            Social Media
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-0 min-w-0 space-y-3">
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

        <TabsContent value="navigation" className="mt-0 min-w-0">
          {activeTab === "navigation" && (
            <Suspense fallback={<FooterSubtabSpinner />}>
              <NavigationMenusSection
                editorEpoch={navigationEditorEpoch}
                menus={config.menus}
                onChange={(menus) =>
                  setConfig((prev) => ({ ...prev, menus }))
                }
              />
            </Suspense>
          )}
        </TabsContent>

        <TabsContent value="social" className="mt-0 min-w-0">
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
      </Tabs> : null}

      {!navigationInvalid ? <div className="sticky bottom-3 z-20 flex items-center justify-between gap-3 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
        <Button type="button" variant="ghost" size="sm" onClick={handleDiscard} disabled={!isDirty || isLoading}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Discard
        </Button>
        <Button
          onClick={handleSave}
          disabled={isLoading || (!isDirty && !navigationSaveRequired)}
          size="sm"
        >
          {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {navigationSaveRequired && !isDirty
            ? "Save typed format"
            : "Save changes"}
        </Button>
      </div> : null}
    </div>
  );
}
