import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import type { HeroSlider } from "./helpers";
import { getServerFnError } from "~/lib/api-helpers";
import { readHeroSliderRevisionConflict } from "~/lib/admin-api-error";
import {
  createHeroSlider,
  getHeroSlider,
  getHeroSliders,
  updateHeroSlider,
} from "~/lib/api-functions/hero-sliders";

const SliderTab = lazy(() =>
  import("./SliderTab").then((module) => ({ default: module.SliderTab })),
);

type SliderType = "desktop" | "mobile";
type SliderState = Record<SliderType, HeroSlider | null>;
type FlagState = Record<SliderType, boolean>;

const EMPTY_SLIDERS: SliderState = { desktop: null, mobile: null };
const EMPTY_FLAGS: FlagState = { desktop: false, mobile: false };

function cloneSlider(slider: HeroSlider | null): HeroSlider | null {
  return slider ? structuredClone(slider) : null;
}

function sliderChanged(
  saved: HeroSlider | null,
  draft: HeroSlider | null,
): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

export function HeroSliderContainer() {
  const [saved, setSaved] = useState<SliderState>(EMPTY_SLIDERS);
  const [drafts, setDrafts] = useState<SliderState>(EMPTY_SLIDERS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<FlagState>(EMPTY_FLAGS);
  const [conflicts, setConflicts] = useState<FlagState>(EMPTY_FLAGS);
  const [activeTab, setActiveTab] = useState<SliderType>("desktop");

  const dirty = useMemo<FlagState>(() => ({
    desktop: sliderChanged(saved.desktop, drafts.desktop),
    mobile: sliderChanged(saved.mobile, drafts.mobile),
  }), [drafts, saved]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getHeroSliders();
        if (cancelled) return;
        const items = Array.isArray(data) ? data : [];
        const next: SliderState = {
          desktop: items.find((slider) => slider.type === "desktop") ?? null,
          mobile: items.find((slider) => slider.type === "mobile") ?? null,
        };
        setSaved({
          desktop: cloneSlider(next.desktop),
          mobile: cloneSlider(next.mobile),
        });
        setDrafts({
          desktop: cloneSlider(next.desktop),
          mobile: cloneSlider(next.mobile),
        });
      } catch (error) {
        toast.error("Hero sliders could not be loaded", {
          description: getServerFnError(error, "Reload this page to try again."),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDraft = (type: SliderType, slider: HeroSlider) => {
    setDrafts((current) => ({ ...current, [type]: slider }));
  };

  const handleCreate = async (type: SliderType) => {
    setSaving((current) => ({ ...current, [type]: true }));
    try {
      const slider = await createHeroSlider({
        data: { type, images: [], isActive: false },
      });
      setSaved((current) => ({ ...current, [type]: cloneSlider(slider) }));
      setDrafts((current) => ({ ...current, [type]: cloneSlider(slider) }));
      toast.success(`${type === "desktop" ? "Desktop" : "Mobile"} hero created`, {
        description: "Add a slide, then turn it on when it is ready.",
      });
    } catch (error) {
      toast.error("Hero slider could not be created", {
        description: getServerFnError(error, "Try again."),
      });
    } finally {
      setSaving((current) => ({ ...current, [type]: false }));
    }
  };

  const handleSave = async (type: SliderType) => {
    const draft = drafts[type];
    if (!draft || saving[type]) return;

    setSaving((current) => ({ ...current, [type]: true }));
    try {
      const updated = await updateHeroSlider({
        data: {
          id: draft.id,
          update: {
            expectedRevision: draft.revision,
            images: draft.images,
            isActive: draft.isActive,
          },
        },
      });
      setSaved((current) => ({ ...current, [type]: cloneSlider(updated) }));
      setDrafts((current) => ({ ...current, [type]: cloneSlider(updated) }));
      setConflicts((current) => ({ ...current, [type]: false }));
      toast.success("Hero changes saved", {
        description: "The storefront homepage is refreshing.",
      });
    } catch (error) {
      if (readHeroSliderRevisionConflict(error)) {
        setConflicts((current) => ({ ...current, [type]: true }));
        toast.error("A newer saved version exists", {
          description: "Your draft is preserved. Load the latest version before saving again.",
        });
      } else {
        toast.error("Hero changes were not saved", {
          description: getServerFnError(error, "Fix any highlighted fields and try again."),
        });
      }
    } finally {
      setSaving((current) => ({ ...current, [type]: false }));
    }
  };

  const handleDiscard = (type: SliderType) => {
    setDrafts((current) => ({ ...current, [type]: cloneSlider(saved[type]) }));
    setConflicts((current) => ({ ...current, [type]: false }));
  };

  const handleLoadLatest = async (type: SliderType) => {
    const draft = drafts[type];
    if (!draft || saving[type]) return;
    setSaving((current) => ({ ...current, [type]: true }));
    try {
      const latest = await getHeroSlider({ data: draft.id });
      setSaved((current) => ({ ...current, [type]: cloneSlider(latest) }));
      setDrafts((current) => ({ ...current, [type]: cloneSlider(latest) }));
      setConflicts((current) => ({ ...current, [type]: false }));
      toast.success("Latest saved hero loaded");
    } catch (error) {
      toast.error("Latest hero could not be loaded", {
        description: getServerFnError(error, "Reload the page to try again."),
      });
    } finally {
      setSaving((current) => ({ ...current, [type]: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading hero sliders</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 py-4">
      <UnsavedChangesGuard
        isDirty={dirty.desktop || dirty.mobile}
        isSubmitting={saving.desktop || saving.mobile}
      />
      <div className="flex flex-wrap items-end justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Homepage hero</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build separate desktop and mobile banners. Changes reach customers only after save.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {dirty.desktop || dirty.mobile ? "Unsaved changes" : "All changes saved"}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SliderType)}>
        <TabsList className="h-9 w-full justify-start gap-1 rounded-lg border bg-muted/20 p-1 sm:w-auto">
          <TabsTrigger value="desktop" className="h-7 gap-2 px-3">
            <ImageIcon className="h-3.5 w-3.5" />
            Desktop
            {dirty.desktop ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
          </TabsTrigger>
          <TabsTrigger value="mobile" className="h-7 gap-2 px-3">
            <span className="h-4 w-2.5 rounded-[3px] border border-current" />
            Mobile
            {dirty.mobile ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
          </TabsTrigger>
        </TabsList>

        {(["desktop", "mobile"] as const).map((type) => (
          <TabsContent key={type} value={type} className="mt-4">
            <Suspense fallback={<SliderTabFallback />}>
              <SliderTab
                type={type}
                slider={drafts[type]}
                dirty={dirty[type]}
                saving={saving[type]}
                conflict={conflicts[type]}
                onCreate={handleCreate}
                onChange={(slider) => setDraft(type, slider)}
                onSave={() => handleSave(type)}
                onDiscard={() => handleDiscard(type)}
                onLoadLatest={() => handleLoadLatest(type)}
              />
            </Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function SliderTabFallback() {
  return (
    <div aria-hidden="true" className="space-y-3 rounded-lg border p-3">
      <div className="h-9 w-56 rounded bg-muted/60" />
      <div className="h-32 rounded border border-dashed bg-muted/20" />
    </div>
  );
}
