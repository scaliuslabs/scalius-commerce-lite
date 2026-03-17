import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Image as ImageIcon, Plus } from "lucide-react";
import { MediaManager } from "../media-manager";
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
} from "@dnd-kit/sortable";
import { SortableSlide } from "./SortableSlide";
import { SlideOverlay } from "./SlideOverlay";
import type { HeroSlider, SliderImage, MediaFile } from "./helpers";
import { generateImageId } from "./helpers";

interface SliderTabProps {
  type: "desktop" | "mobile";
  slider: HeroSlider | null;
  onCreate: (type: "desktop" | "mobile") => void;
  onUpdate: (type: "desktop" | "mobile", updates: Partial<HeroSlider>) => void;
  onUpdateImageLocal: (type: "desktop" | "mobile", imageId: string, updates: Partial<SliderImage>) => void;
  setSlider: (slider: HeroSlider) => void;
}

export function SliderTab({
  type,
  slider,
  onCreate,
  onUpdate,
  onUpdateImageLocal,
  setSlider,
}: SliderTabProps) {
  const [activeDragItem, setActiveDragItem] = useState<SliderImage | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleAddImages = (files: MediaFile[]) => {
    if (!slider) return;

    const newImages: SliderImage[] = files.map((file) => ({
      id: generateImageId(),
      url: file.url,
      title: file.filename,
      link: "",
    }));

    onUpdate(type, {
      images: [...slider.images, ...newImages],
    });
  };

  const handleRemoveImage = (imageId: string) => {
    if (!slider) return;

    onUpdate(type, {
      images: slider.images.filter((img) => img.id !== imageId),
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    const item = slider?.images.find((i) => i.id === event.active.id);
    if (item) {
      setActiveDragItem(item);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !slider) return;

    const activeIndex = slider.images.findIndex((i) => i.id === active.id);
    const overIndex = slider.images.findIndex((i) => i.id === over.id);

    if (activeIndex !== overIndex) {
      const newImages = arrayMove(slider.images, activeIndex, overIndex);
      setSlider({ ...slider, images: newImages });
    }
  };

  const handleDragEnd = (_event: DragEndEvent) => {
    setActiveDragItem(null);
    if (!slider) return;
    onUpdate(type, { images: slider.images });
  };

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
          <Button onClick={() => onCreate(type)}>
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
                onUpdate(type, { isActive: checked })
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
          onSelect={(file) => handleAddImages([file])}
          onSelectMultiple={(files) => handleAddImages(files)}
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
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
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
                  onRemove={handleRemoveImage}
                  onUpdate={(id, u) => onUpdateImageLocal(type, id, u)}
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
}
