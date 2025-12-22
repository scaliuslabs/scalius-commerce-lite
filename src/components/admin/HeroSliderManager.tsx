import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { MediaManager } from "./MediaManager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  defaultDropAnimationSideEffects,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  X,
  GripVertical,
  Image as ImageIcon,
  Link as LinkIcon,
  Type,
  Plus,
} from "lucide-react";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
import { cn } from "@/lib/utils";

// --- Helper Types ---

interface SliderImage {
  id: string;
  url: string;
  title: string;
  link: string;
}

interface HeroSlider {
  id: string;
  type: "desktop" | "mobile";
  images: SliderImage[];
  isActive: boolean;
}

interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}

// --- Debounce Hook ---
function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [timeoutId]);

  return (...args: A) => {
    if (timeoutId) clearTimeout(timeoutId);
    const newTimeoutId = setTimeout(() => {
      callback(...args);
    }, delay);
    setTimeoutId(newTimeoutId);
  };
}

// --- Sortable Slide Component ---
interface SortableSlideProps {
  image: SliderImage;
  index: number;
  type: "desktop" | "mobile";
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SliderImage>) => void;
}

function SortableSlide({
  image,
  index,
  type,
  onRemove,
  onUpdate,
}: SortableSlideProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative flex flex-col md:flex-row gap-4 p-4 rounded-xl border bg-card text-card-foreground shadow-xs transition-all hover:shadow-md",
        isDragging && "opacity-30 z-0 ring-2 ring-primary/20",
        "bg-background",
      )}
    >
      {/* Drag Handle */}
      <div
        {...attributes}
        {...listeners}
        className="shrink-0 flex items-center justify-center w-full md:w-8 text-muted-foreground/50 hover:text-foreground cursor-grab active:cursor-grabbing rounded-md hover:bg-muted/50 transition-colors self-stretch"
      >
        <GripVertical className="w-5 h-5 md:rotate-0 rotate-90" />
      </div>

      {/* Image Preview */}
      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg border bg-muted/30",
          type === "desktop"
            ? "aspect-16/5 w-full md:w-[280px]"
            : "aspect-16/5 w-full md:w-[200px]",
        )}
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.title || "Slide"}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
        <div className="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-lg" />
        <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-sm text-white text-[10px] px-2 py-0.5 rounded-full font-medium">
          Slide {index + 1}
        </div>
      </div>

      {/* Inputs */}
      <div className="flex-1 grid gap-4">
        <div className="grid gap-1.5">
          <Label
            htmlFor={`title-${image.id}`}
            className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"
          >
            <Type className="w-3.5 h-3.5" />
            Title / Alt Text
          </Label>
          <Input
            id={`title-${image.id}`}
            value={image.title}
            onChange={(e) => onUpdate(image.id, { title: e.target.value })}
            placeholder="e.g. Summer Sale Collection"
            className="h-9 transition-colors focus-visible:ring-primary/20"
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor={`link-${image.id}`}
            className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Destination URL
          </Label>
          <Input
            id={`link-${image.id}`}
            value={image.link}
            onChange={(e) => onUpdate(image.id, { link: e.target.value })}
            placeholder="e.g. /collections/summer-sale"
            className="h-9 transition-colors focus-visible:ring-primary/20 bg-muted/20 focus:bg-background"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex md:flex-col items-center justify-end md:justify-start gap-2 pt-2 md:pt-0 border-t md:border-t-0 md:border-l md:pl-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => onRemove(image.id)}
          title="Remove Slide"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

// --- Drag Overlay Component ---
function SlideOverlay({
  image,
  type,
}: {
  image: SliderImage;
  type: "desktop" | "mobile";
}) {
  return (
    <div
      className={cn(
        "flex flex-col md:flex-row gap-4 p-4 rounded-xl border bg-background shadow-xl ring-2 ring-primary/20 cursor-grabbing w-[600px] max-w-[90vw]",
      )}
    >
      <div className="shrink-0 flex items-center justify-center w-8 text-foreground">
        <GripVertical className="w-5 h-5" />
      </div>

      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg border bg-muted/30",
          type === "desktop"
            ? "aspect-16/5 w-[280px]"
            : "aspect-16/5 w-[200px]",
        )}
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.title}
          className="h-full w-full object-cover"
        />
      </div>

      <div className="flex-1 grid gap-4 opacity-50">
        <div className="h-9 w-full bg-muted rounded-md" />
        <div className="h-9 w-full bg-muted rounded-md" />
      </div>
    </div>
  );
}

// --- Main Manager Component ---
export function HeroSliderManager() {
  const [desktopSlider, setDesktopSlider] = useState<HeroSlider | null>(null);
  const [mobileSlider, setMobileSlider] = useState<HeroSlider | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"desktop" | "mobile">("desktop");

  const [activeDragItem, setActiveDragItem] = useState<SliderImage | null>(
    null,
  );

  const DEBOUNCE_DELAY = 500;

  const fetchSliders = async () => {
    try {
      const response = await fetch("/api/settings/hero-sliders");
      const data = await response.json();
      if (data.success) {
        const desktop = data.data.find((s: HeroSlider) => s.type === "desktop");
        const mobile = data.data.find((s: HeroSlider) => s.type === "mobile");
        setDesktopSlider(desktop || null);
        setMobileSlider(mobile || null);
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to fetch sliders",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSliders();
  }, []);

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
      const response = await fetch("/api/settings/hero-sliders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          images: [],
          isActive: true,
        }),
      });

      const data = await response.json();
      if (data.success) {
        if (type === "desktop") setDesktopSlider(data.data);
        else setMobileSlider(data.data);

        toast({ title: "Success", description: "Slider created successfully" });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to create slider",
        variant: "destructive",
      });
    }
  };

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
      const response = await fetch(`/api/settings/hero-sliders/${slider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      const data = await response.json();
      if (data.success) {
        // Sync with server response to be sure
        if (type === "desktop") setDesktopSlider(data.data);
        else setMobileSlider(data.data);

        if (updates.isActive !== undefined) {
          toast({
            title: "Updated",
            description: `Slider ${updates.isActive ? "activated" : "deactivated"}`,
          });
        }
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to update slider",
        variant: "destructive",
      });
    }
  };

  // Handle adding multiple images
  const handleAddImages = (type: "desktop" | "mobile", files: MediaFile[]) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    const newImages: SliderImage[] = files.map((file) => ({
      id: `img_${Math.random().toString(36).substring(7)}`,
      url: file.url,
      title: file.filename,
      link: "",
    }));

    handleUpdate(type, {
      images: [...slider.images, ...newImages],
    });
  };

  const handleRemoveImage = (type: "desktop" | "mobile", imageId: string) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    handleUpdate(type, {
      images: slider.images.filter((img) => img.id !== imageId),
    });
  };

  const handleUpdateImageLocal = (
    type: "desktop" | "mobile",
    imageId: string,
    updates: Partial<SliderImage>,
  ) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    // Update local state immediately
    if (type === "desktop") {
      setDesktopSlider({
        ...slider,
        images: slider.images.map((img) =>
          img.id === imageId ? { ...img, ...updates } : img,
        ),
      });
    } else {
      setMobileSlider({
        ...slider,
        images: slider.images.map((img) =>
          img.id === imageId ? { ...img, ...updates } : img,
        ),
      });
    }

    debouncedHandleUpdateImage(type, imageId, updates);
  };

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (
    event: DragStartEvent,
    type: "desktop" | "mobile",
  ) => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    const item = slider?.images.find((i) => i.id === event.active.id);
    if (item) {
      setActiveDragItem(item);
    }
  };

  const handleDragOver = (event: DragOverEvent, type: "desktop" | "mobile") => {
    const { active, over } = event;
    if (!over) return;
    if (active.id === over.id) return;

    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    const activeIndex = slider.images.findIndex((i) => i.id === active.id);
    const overIndex = slider.images.findIndex((i) => i.id === over.id);

    if (activeIndex !== overIndex) {
      const newImages = arrayMove(slider.images, activeIndex, overIndex);
      // Local update for smoothness
      if (type === "desktop")
        setDesktopSlider({ ...slider, images: newImages });
      else setMobileSlider({ ...slider, images: newImages });
    }
  };

  const handleDragEnd = (_event: DragEndEvent, type: "desktop" | "mobile") => {
    setActiveDragItem(null);

    const slider = type === "desktop" ? desktopSlider : mobileSlider;
    if (!slider) return;

    // Persist the final order
    handleUpdate(type, { images: slider.images });
  };

  const renderSliderContent = (type: "desktop" | "mobile") => {
    const slider = type === "desktop" ? desktopSlider : mobileSlider;

    if (!slider) {
      return (
        <Card className="border-dashed shadow-sm">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <div className="bg-muted rounded-full p-4 mb-4">
              <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
            </div>
            <h3 className="font-semibold text-lg mb-2">No {type} Slider</h3>
            <p className="max-w-xs mb-6 text-sm">
              Create a {type} slider to start adding banner images to your
              storefront.
            </p>
            <Button onClick={() => handleCreate(type)}>
              <Plus className="w-4 h-4 mr-2" />
              Create {type === "desktop" ? "Desktop" : "Mobile"} Slider
            </Button>
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-muted/30 p-4 rounded-lg border">
          <div className="flex items-center gap-4">
            <div className="flex items-center space-x-2">
              <Switch
                id={`${type}-active`}
                checked={slider.isActive}
                onCheckedChange={(checked) =>
                  handleUpdate(type, { isActive: checked })
                }
              />
              <Label
                htmlFor={`${type}-active`}
                className="font-medium cursor-pointer"
              >
                {slider.isActive ? "Active" : "Inactive"}
              </Label>
            </div>
            <div className="hidden sm:block h-4 w-px bg-border" />
            <Badge
              variant="secondary"
              className="font-normal text-muted-foreground"
            >
              {type === "desktop"
                ? "Recommended: 1400x450 px"
                : "Recommended: 640x200 px"}
            </Badge>
          </div>

          <MediaManager
            onSelect={(file) => handleAddImages(type, [file])}
            onSelectMultiple={(files) => handleAddImages(type, files)}
            trigger={
              <Button size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                Add Slide Image
              </Button>
            }
          />
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => handleDragStart(e, type)}
          onDragOver={(e) => handleDragOver(e, type)}
          onDragEnd={(e) => handleDragEnd(e, type)}
        >
          <SortableContext
            items={slider.images.map((img) => img.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {slider.images.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed rounded-xl bg-muted/10">
                  <p className="text-muted-foreground text-sm">
                    No images added yet. Click &quot;Add Slide Image&quot; to
                    begin.
                  </p>
                </div>
              ) : (
                slider.images.map((image, index) => (
                  <SortableSlide
                    key={image.id}
                    image={image}
                    index={index}
                    type={type}
                    onRemove={(id) => handleRemoveImage(type, id)}
                    onUpdate={(id, u) => handleUpdateImageLocal(type, id, u)}
                  />
                ))
              )}
            </div>
          </SortableContext>

          {typeof document !== "undefined" &&
            createPortal(
              <DragOverlay
                dropAnimation={{
                  sideEffects: defaultDropAnimationSideEffects({
                    styles: {
                      active: {
                        opacity: "0.4",
                      },
                    },
                  }),
                }}
              >
                {activeDragItem && (
                  <SlideOverlay image={activeDragItem} type={type} />
                )}
              </DragOverlay>,
              document.body,
            )}
        </DndContext>
      </div>
    );
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
          {renderSliderContent("desktop")}
        </TabsContent>

        <TabsContent
          value="mobile"
          className="animate-in fade-in-50 slide-in-from-bottom-2 duration-300"
        >
          {renderSliderContent("mobile")}
        </TabsContent>
      </Tabs>
    </div>
  );
}
