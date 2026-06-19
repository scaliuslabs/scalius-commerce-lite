import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { GripVertical, Image as ImageIcon, Plus } from "lucide-react";
import { MediaManager } from "../media-manager";
import { SlideRow } from "./SlideRow";
import type { HeroSlider, SliderImage, MediaFile } from "./helpers";
import { generateImageId } from "./helpers";

const SortableSlidesEditor = lazy(() =>
  import("./SortableSlidesEditor").then((module) => ({
    default: module.SortableSlidesEditor,
  })),
);

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
  const [isReordering, setIsReordering] = useState(false);

  useEffect(() => {
    if ((slider?.images.length ?? 0) < 2 && isReordering) {
      setIsReordering(false);
    }
  }, [isReordering, slider?.images.length]);

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

        <div className="flex flex-wrap items-center gap-2">
          {slider.images.length > 1 && (
            <Button
              type="button"
              size="sm"
              variant={isReordering ? "secondary" : "outline"}
              className="gap-2"
              onClick={() => setIsReordering((value) => !value)}
            >
              <GripVertical className="h-4 w-4" />
              {isReordering ? "Done" : "Reorder"}
            </Button>
          )}

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
      </div>

      {slider.images.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed rounded-xl bg-muted/10">
          <p className="text-muted-foreground text-sm">
            No images added yet. Click &quot;Add Slide Image&quot; to begin.
          </p>
        </div>
      ) : isReordering ? (
        <Suspense
          fallback={
            <SlideRows
              images={slider.images}
              type={type}
              onRemove={handleRemoveImage}
              onUpdate={(id, u) => onUpdateImageLocal(type, id, u)}
            />
          }
        >
          <SortableSlidesEditor
            type={type}
            slider={slider}
            onUpdate={onUpdate}
            onUpdateImageLocal={onUpdateImageLocal}
            onRemove={handleRemoveImage}
            setSlider={setSlider}
          />
        </Suspense>
      ) : (
        <SlideRows
          images={slider.images}
          type={type}
          onRemove={handleRemoveImage}
          onUpdate={(id, u) => onUpdateImageLocal(type, id, u)}
        />
      )}
    </div>
  );
}

function SlideRows({
  images,
  type,
  onRemove,
  onUpdate,
}: {
  images: SliderImage[];
  type: "desktop" | "mobile";
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SliderImage>) => void;
}) {
  return (
    <div className="space-y-3">
      {images.map((image, index) => (
        <SlideRow
          key={image.id}
          image={image}
          index={index}
          type={type}
          onRemove={onRemove}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}
