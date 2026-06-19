import { lazy, Suspense, useState, useEffect } from "react";
import { toast } from "sonner";
import { Image as ImageIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useDebouncedCallback } from "~/hooks/use-debounced-callback";
import type { HeroSlider, SliderImage } from "./helpers";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getHeroSliders,
  createHeroSlider,
  updateHeroSlider,
} from "~/lib/api-functions/hero-sliders";

const SliderTab = lazy(() =>
  import("./SliderTab").then((module) => ({
    default: module.SliderTab,
  })),
);

export function HeroSliderContainer() {
  const [desktopSlider, setDesktopSlider] = useState<HeroSlider | null>(null);
  const [mobileSlider, setMobileSlider] = useState<HeroSlider | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"desktop" | "mobile">("desktop");

  const DEBOUNCE_DELAY = 500;

  const fetchSliders = async () => {
    try {
      const data = await getHeroSliders();
      const items = Array.isArray(data) ? data : [];
      const desktop = items.find((s) => s.type === "desktop");
      const mobile = items.find((s) => s.type === "mobile");
      setDesktopSlider(desktop ?? null);
      setMobileSlider(mobile ?? null);
    } catch {
      toast.error("Failed to fetch sliders");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSliders();
  }, []);

  const handleUpdate = async (
    type: "desktop" | "mobile",
    updates: Partial<HeroSlider>,
  ) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    // Optimistically update state
    if (type === "desktop") setDesktopSlider({ ...slider, ...updates });
    else setMobileSlider({ ...slider, ...updates });

    try {
      const updatedSlider = await updateHeroSlider({
        data: { id: slider.id, update: updates },
      });
      if (type === "desktop") setDesktopSlider(updatedSlider);
      else setMobileSlider(updatedSlider);

      if (updates.isActive !== undefined) {
        toast.success(`Slider ${updates.isActive ? "activated" : "deactivated"}`);
      }
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to update slider"));
    }
  };

  const debouncedHandleUpdateImage = useDebouncedCallback(
    (
      type: "desktop" | "mobile",
      imageId: string,
      updates: Partial<SliderImage>,
    ) => {
      const slider = type === "desktop" ? desktopSlider : mobileSlider;
      if (!slider) return;

      const currentImage = slider.images.find((img) => img.id === imageId);
      if (!currentImage) return;

      const updatedImage = { ...currentImage, ...updates };

      handleUpdate(type, {
        images: slider.images.map((img) =>
          img.id === imageId ? updatedImage : img,
        ),
      });
    },
    DEBOUNCE_DELAY,
  );

  const handleCreate = async (type: "desktop" | "mobile") => {
    try {
      const slider = await createHeroSlider({
        data: { type, images: [], isActive: true },
      });
      if (type === "desktop") setDesktopSlider(slider);
      else setMobileSlider(slider);

      toast.success("Slider created successfully");
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to create slider"));
    }
  };

  const handleUpdateImageLocal = (
    type: "desktop" | "mobile",
    imageId: string,
    updates: Partial<SliderImage>,
  ) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    // Update local state immediately
    const updatedSlider = {
      ...slider,
      images: slider.images.map((img) =>
        img.id === imageId ? { ...img, ...updates } : img,
      ),
    };

    if (type === "desktop") setDesktopSlider(updatedSlider);
    else setMobileSlider(updatedSlider);

    debouncedHandleUpdateImage(type, imageId, updates);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px] w-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="container max-w-5xl py-6 mx-auto">
      <div className="flex flex-col gap-2 mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Hero Sliders</h1>
        <p className="text-muted-foreground">
          Manage the main banner sliders for your storefront homepage.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "desktop" | "mobile")}
        className="space-y-6"
      >
        <TabsList className="grid w-full grid-cols-2 max-w-[400px]">
          <TabsTrigger value="desktop" className="gap-2">
            <ImageIcon className="w-4 h-4" />
            Desktop Slider
          </TabsTrigger>
          <TabsTrigger value="mobile" className="gap-2">
            <div className="w-4 h-4 border-2 border-current rounded-[3px] flex items-center justify-center p-px">
              <div className="w-full h-full bg-current rounded-[1px] opacity-50" />
            </div>
            Mobile Slider
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="desktop"
          className="animate-in fade-in-50 slide-in-from-bottom-2 duration-300"
        >
          <Suspense fallback={<SliderTabFallback />}>
            <SliderTab
              type="desktop"
              slider={desktopSlider}
              onCreate={handleCreate}
              onUpdate={handleUpdate}
              onUpdateImageLocal={handleUpdateImageLocal}
              setSlider={setDesktopSlider}
            />
          </Suspense>
        </TabsContent>

        <TabsContent
          value="mobile"
          className="animate-in fade-in-50 slide-in-from-bottom-2 duration-300"
        >
          <Suspense fallback={<SliderTabFallback />}>
            <SliderTab
              type="mobile"
              slider={mobileSlider}
              onCreate={handleCreate}
              onUpdate={handleUpdate}
              onUpdateImageLocal={handleUpdateImageLocal}
              setSlider={setMobileSlider}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SliderTabFallback() {
  return (
    <div
      aria-hidden="true"
      className="rounded-lg border bg-muted/10 p-4 space-y-4"
    >
      <div className="h-9 w-48 rounded-md bg-muted/60" />
      <div className="h-28 rounded-xl border border-dashed bg-background/60" />
    </div>
  );
}
