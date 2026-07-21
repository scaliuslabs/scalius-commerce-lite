// src/components/admin/header-builder/HeaderBuilder.tsx
import { useState, lazy, Suspense, useEffect, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import {
  Contact,
  Image as ImageIcon,
  Loader2,
  Menu,
  Megaphone,
  RotateCcw,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useQueryClient } from "@tanstack/react-query";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getGeneralSettings,
  saveHeaderConfig,
} from "~/lib/api-functions/settings";
import { readSitePresentationRevisionConflict } from "~/lib/admin-api-error";
import { useConfigDraft } from "~/components/admin/shared/use-config-draft";
import { rebaseHeaderDraft } from "~/components/admin/shared/presentation-draft";
import { PresentationRevisionConflictNotice } from "~/components/admin/shared/PresentationRevisionConflictNotice";
import { NavigationConfigReadinessNotice } from "~/components/admin/settings/NavigationConfigReadinessNotice";
import { Card } from "~/components/ui/card";
import { normalizeHeaderLogoWidth } from "@scalius/shared/brand-presentation";

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
    logo: {
      ...defaultHeaderConfig.logo,
      ...config.logo,
      width: normalizeHeaderLogoWidth(config.logo?.width),
    },
    favicon: { ...defaultHeaderConfig.favicon, ...config.favicon },
    contact: { ...defaultHeaderConfig.contact, ...config.contact },
    social: Array.isArray(config.social) ? config.social : [],
    navigation: Array.isArray(config.navigation) ? config.navigation : [],
  };
}

export function HeaderBuilder({
  activePanel,
  initialConfig,
  initialRevision = 0,
  readiness,
  onPanelChange,
  onSave,
}: HeaderBuilderProps) {
  const queryClient = useQueryClient();

  const normalizedInitialConfig = useMemo(
    () => normalizeHeaderConfig(initialConfig),
    [initialConfig],
  );
  const {
    config,
    setConfig,
    isDirty,
    discard,
    markSaved,
    adoptSaved,
    rebaseOnto,
  } = useConfigDraft(normalizedInitialConfig);
  const [revision, setRevision] = useState(initialRevision);
  const [revisionConflict, setRevisionConflict] = useState<{
    config: HeaderConfig;
    revision: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [normalizationSaved, setNormalizationSaved] = useState(false);
  const [internalActivePanel, setInternalActivePanel] =
    useState<HeaderBuilderPanel>("branding");
  const activeTab = activePanel ?? internalActivePanel;
  const isEditingLocked = readiness?.state === "invalid";
  const requiresNormalizationSave =
    readiness?.state === "legacy_normalized" && !normalizationSaved;
  const hasPendingSave = isDirty || requiresNormalizationSave;
  useEffect(() => {
    if (!isDirty && !revisionConflict) setRevision(initialRevision);
  }, [initialRevision, isDirty, revisionConflict]);

  const handlePanelChange = (panel: string) => {
    const nextPanel = panel as HeaderBuilderPanel;
    if (activePanel === undefined) setInternalActivePanel(nextPanel);
    onPanelChange?.(nextPanel);
  };

  const handleDiscard = () => {
    discard();
  };

  const useLatestRevision = () => {
    if (!revisionConflict) return;
    adoptSaved(revisionConflict.config);
    setRevision(revisionConflict.revision);
    setRevisionConflict(null);
  };

  const mergeLatestRevision = () => {
    if (!revisionConflict) return;
    rebaseOnto(revisionConflict.config, rebaseHeaderDraft);
    setRevision(revisionConflict.revision);
    setRevisionConflict(null);
  };

  const handleSave = async () => {
    if (isLoading || revisionConflict || isEditingLocked) return;

    if (!config.logo.src) {
      toast.error("Logo Required", { description: "Please select a logo before saving." });
      handlePanelChange("branding");
      return;
    }

    setIsLoading(true);
    try {
      const draftBeingSaved = config;
      const { navigation: _navigation, ...storedConfig } = draftBeingSaved;
      const saved = typeof onSave === "function"
        ? await onSave(storedConfig, revision)
        : await saveHeaderConfig({
            data: { ...storedConfig, expectedRevision: revision },
          });

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      setRevision(saved.revision);
      markSaved(draftBeingSaved);
      setNormalizationSaved(true);
      toast.success("Header saved", { description: "Storefront layout is refreshing." });
    } catch (error: unknown) {
      const conflict = readSitePresentationRevisionConflict(error, "header");
      if (conflict) {
        try {
          const latest = await getGeneralSettings();
          const latestRevision = latest.revisions.header;
          setRevisionConflict({
            config: normalizeHeaderConfig(
              latest.headerConfig as unknown as HeaderConfig,
            ),
            revision: latestRevision,
          });
          queryClient.setQueryData(["settings", "general"], latest);
          toast.error("Header changed elsewhere", {
            description: "Your draft is safe. Choose how to reconcile it with the latest version.",
          });
        } catch (latestError: unknown) {
          toast.error("Header changed elsewhere", {
            description: getServerFnError(
              latestError,
              "Your draft is safe, but the latest version could not be loaded. Try saving again.",
            ),
          });
        }
        return;
      }
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
              isEditingLocked
                ? "bg-destructive"
                : hasPendingSave
                  ? "bg-amber-500"
                  : "bg-emerald-500",
            )}
          />
          {isEditingLocked
            ? "Needs repair"
            : isDirty
              ? "Unsaved changes"
              : requiresNormalizationSave
                ? "Review required"
                : "All changes saved"}
        </div>
      </div>

      <NavigationConfigReadinessNotice
        section="header"
        readiness={normalizationSaved ? { state: "ready" } : readiness}
      />

      {isEditingLocked ? null : (
        <>

      {revisionConflict ? (
        <PresentationRevisionConflictNotice
          revision={revisionConflict.revision}
          onMerge={mergeLatestRevision}
          onUseLatest={useLatestRevision}
        />
      ) : null}

      <Tabs value={activeTab} onValueChange={handlePanelChange} className="grid gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border bg-muted/20 p-1 lg:sticky lg:top-20 lg:flex-col lg:self-start">
          <TabsTrigger
            value="branding"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
          >
            <ImageIcon className="h-4 w-4" />
            Branding
          </TabsTrigger>
          <TabsTrigger
            value="announcement"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
          >
            <Megaphone className="h-4 w-4" />
            Announcement
          </TabsTrigger>
          <TabsTrigger
            value="contact-social"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
          >
            <Contact className="h-4 w-4" />
            Contact & Social
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
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
          <Card className="flex min-h-48 flex-col items-start justify-center gap-3 p-5">
            <div className="grid size-10 place-items-center rounded-lg bg-muted">
              <Menu className="size-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Menus have their own workspace</h3>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                Arrange reusable menus, publish changes, and choose storefront locations without overwriting header branding.
              </p>
            </div>
            <Button asChild size="sm">
              <Link to="/admin/navigation" search={{ panel: "items", q: "" }}>
                Open Navigation
              </Link>
            </Button>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="sticky bottom-3 z-20 flex items-center justify-between gap-3 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={handleDiscard}
          disabled={!isDirty || isLoading}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          Discard
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            isLoading ||
            Boolean(revisionConflict) ||
            !config.logo.src ||
            !hasPendingSave
          }
          className="relative min-h-11 min-w-[124px] sm:min-h-9"
          size="sm"
        >
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-primary rounded-md">
              <Loader2 className="h-5 w-5 animate-spin text-primary-foreground" />
            </div>
          ) : null}
          <span className={cn(isLoading ? "opacity-0" : "opacity-100")}>
            {requiresNormalizationSave && !isDirty
              ? "Save typed format"
              : "Save changes"}
          </span>
        </Button>
      </div>
        </>
      )}
    </div>
  );
}
