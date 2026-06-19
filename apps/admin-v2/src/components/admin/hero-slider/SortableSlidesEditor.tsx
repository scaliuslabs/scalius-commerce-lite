import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import type { HeroSlider, SliderImage } from "./helpers";

interface SortableSlidesEditorProps {
  type: "desktop" | "mobile";
  slider: HeroSlider;
  onUpdate: (type: "desktop" | "mobile", updates: Partial<HeroSlider>) => void;
  onUpdateImageLocal: (
    type: "desktop" | "mobile",
    imageId: string,
    updates: Partial<SliderImage>,
  ) => void;
  onRemove: (imageId: string) => void;
  setSlider: (slider: HeroSlider) => void;
}

export function SortableSlidesEditor({
  type,
  slider,
  onUpdate,
  onUpdateImageLocal,
  onRemove,
  setSlider,
}: SortableSlidesEditorProps) {
  const [activeDragItem, setActiveDragItem] = useState<SliderImage | null>(
    null,
  );
  const latestImagesRef = useRef(slider.images);

  useEffect(() => {
    latestImagesRef.current = slider.images;
  }, [slider.images]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const item = slider.images.find((i) => i.id === event.active.id);
    if (item) {
      setActiveDragItem(item);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const latestImages = latestImagesRef.current;
    const activeIndex = latestImages.findIndex((i) => i.id === active.id);
    const overIndex = latestImages.findIndex((i) => i.id === over.id);

    if (activeIndex < 0 || overIndex < 0) return;

    if (activeIndex !== overIndex) {
      const newImages = arrayMove(latestImages, activeIndex, overIndex);
      latestImagesRef.current = newImages;
      setSlider({ ...slider, images: newImages });
    }
  };

  const handleDragEnd = (_event: DragEndEvent) => {
    setActiveDragItem(null);
    onUpdate(type, { images: latestImagesRef.current });
  };

  return (
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
          {slider.images.map((image, index) => (
            <SortableSlide
              key={image.id}
              image={image}
              index={index}
              type={type}
              onRemove={onRemove}
              onUpdate={(id, u) => onUpdateImageLocal(type, id, u)}
            />
          ))}
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
  );
}
