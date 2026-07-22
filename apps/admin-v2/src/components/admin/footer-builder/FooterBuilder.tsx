// src/components/admin/footer-builder/FooterBuilder.tsx
import { useState, lazy, Suspense, useEffect, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Button } from "~/components/ui/button";
import { toast } from "sonner";
import { Image as ImageIcon, LayoutList, Loader2, RotateCcw, Share2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@scalius/shared/utils";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getGeneralSettings,
  saveFooterConfig,
} from "~/lib/api-functions/settings";
import { readSitePresentationRevisionConflict } from "~/lib/admin-api-error";
import { useConfigDraft } from "~/components/admin/shared/use-config-draft";
import { rebaseFooterDraft } from "~/components/admin/shared/presentation-draft";
import { PresentationRevisionConflictNotice } from "~/components/admin/shared/PresentationRevisionConflictNotice";
import { NavigationConfigReadinessNotice } from "~/components/admin/settings/NavigationConfigReadinessNotice";
import { Card } from "~/components/ui/card";

import { BrandingSection } from "./BrandingSection";
import { ContentSection } from "./ContentSection";

import type {
  FooterConfig,
  FooterBuilderPanel,
  FooterBuilderProps,
} from "./types";
import { defaultFooterConfig } from "./types";

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
  initialRevision = 0,
  readiness,
  onPanelChange,
  onSave,
}: FooterBuilderProps) {
  const queryClient = useQueryClient();

  const normalizedInitialConfig = useMemo(
    () => normalizeFooterConfig(initialConfig),
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
    config: FooterConfig;
    revision: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [normalizationSaved, setNormalizationSaved] = useState(false);
  const [internalActivePanel, setInternalActivePanel] =
    useState<FooterBuilderPanel>("branding");
  const activeTab = activePanel ?? internalActivePanel;
  const isEditingLocked = readiness?.state === "invalid";
  const requiresNormalizationSave =
    readiness?.state === "legacy_normalized" && !normalizationSaved;
  const hasPendingSave = isDirty || requiresNormalizationSave;
  useEffect(() => {
    if (!isDirty && !revisionConflict) setRevision(initialRevision);
  }, [initialRevision, isDirty, revisionConflict]);

  const handlePanelChange = (panel: string) => {
    const nextPanel = panel as FooterBuilderPanel;
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
    rebaseOnto(revisionConflict.config, rebaseFooterDraft);
    setRevision(revisionConflict.revision);
    setRevisionConflict(null);
  };

  const handleSave = async () => {
    if (isLoading || revisionConflict || isEditingLocked) return;

    setIsLoading(true);
    try {
      const draftBeingSaved = config;
      const { menus: _menus, ...storedConfig } = draftBeingSaved;
      const saved = typeof onSave === "function"
        ? await onSave(storedConfig, revision)
        : await saveFooterConfig({
            data: { ...storedConfig, expectedRevision: revision },
          });

      queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      setRevision(saved.revision);
      markSaved(draftBeingSaved);
      setNormalizationSaved(true);
      toast.success("Footer saved", { description: "Storefront layout is refreshing." });
    } catch (error: unknown) {
      const conflict = readSitePresentationRevisionConflict(error, "footer");
      if (conflict) {
        try {
          const latest = await getGeneralSettings();
          const latestRevision = latest.revisions.footer;
          setRevisionConflict({
            config: normalizeFooterConfig(
              latest.footerConfig as unknown as FooterConfig,
            ),
            revision: latestRevision,
          });
          queryClient.setQueryData(["settings", "general"], latest);
          toast.error("Footer changed elsewhere", {
            description: "Your draft is safe. Choose how to reconcile it with the latest version.",
          });
        } catch (latestError: unknown) {
          toast.error("Footer changed elsewhere", {
            description: getServerFnError(
              latestError,
              "Your draft is safe, but the latest version could not be loaded. Try saving again.",
            ),
          });
        }
        return;
      }
      console.error("Error saving footer:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to save.") });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <h2 className="text-lg font-semibold tracking-tight">Storefront footer</h2>
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
        section="footer"
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
            Branding & text
          </TabsTrigger>
          <TabsTrigger
            value="navigation"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
          >
            <LayoutList className="h-4 w-4" />
            Navigation menus
          </TabsTrigger>
          <TabsTrigger
            value="social"
            className="h-11 shrink-0 justify-start gap-2 px-3 sm:h-9 lg:w-full"
          >
            <Share2 className="h-4 w-4" />
            Social media
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
          <Card className="flex min-h-48 flex-col items-start justify-center gap-3 p-5">
            <div className="grid size-10 place-items-center rounded-lg bg-muted">
              <LayoutList className="size-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">Footer menus</h3>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                Manage menus and assign them to footer columns.
              </p>
            </div>
            <Button asChild size="sm">
              <Link to="/admin/navigation" search={{ panel: "placements", q: "" }}>
                Manage menus
              </Link>
            </Button>
          </Card>
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
            !hasPendingSave
          }
          size="sm"
          className="min-h-11 sm:min-h-9"
        >
          {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {requiresNormalizationSave && !isDirty
            ? "Save typed format"
            : "Save changes"}
        </Button>
      </div>
        </>
      )}
    </div>
  );
}
