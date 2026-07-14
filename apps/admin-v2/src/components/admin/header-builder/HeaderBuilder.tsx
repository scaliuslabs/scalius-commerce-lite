// src/components/admin/header-builder/HeaderBuilder.tsx
import { useState, lazy, Suspense, useEffect, useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import {
  Contact,
  Image as ImageIcon,
  Loader2,
  Menu,
  Megaphone,
  RotateCcw,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { stripNavigationResolution } from "@scalius/shared/navigation-target";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import { saveHeaderConfig } from "~/lib/api-functions/settings";
import { useConfigDraft } from "~/components/admin/shared/use-config-draft";
import { NavigationConfigReadinessNotice } from "~/components/admin/settings/NavigationConfigReadinessNotice";

import { BrandingSection } from "./BrandingSection";
import { TopBarSection } from "./TopBarSection";
import { ContactSection } from "./ContactSection";

import type {
  HeaderConfig,
  HeaderBuilderPanel,
  HeaderBuilderProps,
} from "./types";
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

export function normalizeHeaderConfig(config?: HeaderConfig | null): HeaderConfig {
  if (!config) return defaultHeaderConfig;
  return {
    topBar: { ...defaultHeaderConfig.topBar, ...config.topBar },
    logo: { ...defaultHeaderConfig.logo, ...config.logo },
    favicon: { ...defaultHeaderConfig.favicon, ...config.favicon },
    contact: { ...defaultHeaderConfig.contact, ...config.contact },
    social: Array.isArray(config.social) ? config.social : [],
    navigation: Array.isArray(config.navigation) ? config.navigation : [],
  };
}

export function HeaderBuilder({
  activePanel,
  initialConfig,
  readiness,
  onPanelChange,
  onSave,
}: HeaderBuilderProps) {
  const { getStorefrontPath } = useStorefrontUrl();
  const queryClient = useQueryClient();

  const normalizedInitialConfig = useMemo(
    () => normalizeHeaderConfig(initialConfig),
    [initialConfig],
  );
  const { config, setConfig, isDirty, discard, markSaved } =
    useConfigDraft(normalizedInitialConfig);
  const [isLoading, setIsLoading] = useState(false);
  const [internalActivePanel, setInternalActivePanel] =
    useState<HeaderBuilderPanel>("branding");
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
    const nextPanel = panel as HeaderBuilderPanel;
    if (activePanel === undefined) setInternalActivePanel(nextPanel);
    onPanelChange?.(nextPanel);
  };

  const handleDiscard = () => {
    discard();
    setNavigationEditorEpoch((current) => current + 1);
  };

  const handleSave = async () => {
    if (isLoading || navigationInvalid) return;

    if (!config.logo.src) {
      toast.error("Logo Required", { description: "Please select a logo before saving." });
      handlePanelChange("branding");
      return;
    }

    setIsLoading(true);
    try {
      const storedConfig: HeaderConfig = {
        ...config,
        navigation: config.navigation.map(stripNavigationResolution),
      };
      if (typeof onSave === "function") {
        await onSave(storedConfig);
      } else {
        await saveHeaderConfig({ data: storedConfig });
      }

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      markSaved();
      if (readiness?.state === "legacy_normalized") setLegacyFormatSaved(true);
      setNavigationEditorEpoch((current) => current + 1);
      toast.success("Header saved", { description: "Storefront layout is refreshing." });
    } catch (error: unknown) {
      console.error("Error saving header:", error);
      toast.error("Save Failed", { description: getServerFnError(error, "Failed to save header configuration.") });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Storefront header</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Brand, announce, and guide customers from one compact workspace.
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
        section="header"
        readiness={legacyFormatSaved ? { state: "ready" } : readiness}
      />

      {!navigationInvalid ? <Tabs value={activeTab} onValueChange={handlePanelChange} className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border bg-muted/20 p-1 lg:sticky lg:top-20 lg:flex-col lg:self-start">
          <TabsTrigger
            value="branding"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <ImageIcon className="h-4 w-4" />
            Branding
          </TabsTrigger>
          <TabsTrigger
            value="announcement"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <Megaphone className="h-4 w-4" />
            Announcement
          </TabsTrigger>
          <TabsTrigger
            value="contact-social"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <Contact className="h-4 w-4" />
            Contact & Social
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="h-9 shrink-0 justify-start gap-2 px-3 lg:w-full"
          >
            <Menu className="h-4 w-4" />
            Navigation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-0 min-w-0">
          <BrandingSection
            logo={config.logo}
            favicon={config.favicon}
            onLogoChange={(logo) => setConfig((prev) => ({ ...prev, logo }))}
            onFaviconChange={(favicon) =>
              setConfig((prev) => ({ ...prev, favicon }))
            }
          />
        </TabsContent>

        <TabsContent value="announcement" className="mt-0 min-w-0">
          <TopBarSection
            topBar={config.topBar}
            onChange={(topBar) => setConfig((prev) => ({ ...prev, topBar }))}
          />
        </TabsContent>

        <TabsContent value="contact-social" className="mt-0 min-w-0 space-y-3">
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

        <TabsContent value="navigation" className="mt-0 min-w-0">
          {activeTab === "navigation" && (
            <Suspense fallback={<HeaderSubtabSpinner />}>
              <NavigationSection
                editorEpoch={navigationEditorEpoch}
                navigation={config.navigation}
                onChange={(navigation) =>
                  setConfig((prev) => ({ ...prev, navigation }))
                }
                getStorefrontPath={getStorefrontPath}
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
          disabled={
            isLoading ||
            !config.logo.src ||
            (!isDirty && !navigationSaveRequired)
          }
          className="relative min-w-[124px]"
          size="sm"
        >
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-primary rounded-md">
              <Loader2 className="h-5 w-5 animate-spin text-primary-foreground" />
            </div>
          ) : null}
          <span className={cn(isLoading ? "opacity-0" : "opacity-100")}>
            {navigationSaveRequired && !isDirty
              ? "Save typed format"
              : "Save changes"}
          </span>
        </Button>
      </div> : null}
    </div>
  );
}
