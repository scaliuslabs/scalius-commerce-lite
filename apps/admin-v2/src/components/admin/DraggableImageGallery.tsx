import { useState, useEffect, useRef } from "react";
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
  type DropAnimation,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import {
  X,
  ChevronDown,
  ChevronUp,
  GripVertical,
  ImageIcon,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import type { MediaFile } from "@/components/admin/media-manager/types";
import { getSortableStyle } from "./shared/sortable-style";

interface DraggableImageGalleryProps {
  images: MediaFile[];
  variantImageMappingByImageId?: Record<string, string>;
  enableVariantImages: boolean;
  onImagesReorder: (images: MediaFile[]) => void;
  onImageRemove: (index: number) => void;
  maxVisible?: number;
  onShowAll?: () => void; // Kept for interface compatibility but can be ignored if we handle locally
}

// --- Sortable Item Component ---
interface SortableImageProps {
  image: MediaFile;
  index: number;
  optionMapping?: string;
  onRemove: (index: number) => void;
}

function SortableImage({
  image,
  index,
  optionMapping,
  onRemove,
}: SortableImageProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id });

  const style = getSortableStyle(transform, transition);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative flex flex-col gap-1 rounded-lg bg-background touch-none",
        isDragging && "opacity-30 z-0",
      )}
    >
      {/* Image Container */}
      <div
        {...attributes}
        {...listeners}
        className="relative aspect-square w-full overflow-hidden rounded-lg border bg-muted/30 cursor-grab active:cursor-grabbing hover:border-primary/50 transition-colors"
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.filename}
          className="h-full w-full object-cover shrink-0 transition-transform duration-500 group-hover:scale-105"
          loading="lazy"
          decoding="async"
        />

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />

        {/* Global/Group Hover Number Overlay */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/gallery:opacity-100 transition-opacity duration-300 pointer-events-none">
          <span className="text-4xl font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
            {index + 1}
          </span>
        </div>

        {/* Primary Badge (On Image) */}
        {index === 0 && (
          <div className="absolute bottom-2 left-2 right-auto pointer-events-none">
            <span className="bg-blue-600/90 backdrop-blur-[2px] text-white text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm">
              Primary
            </span>
          </div>
        )}

        {/* Grab Handle Icon (Subtle) */}
        <div className="absolute top-2 left-2 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="w-4 h-4 drop-shadow-md" />
        </div>
      </div>

      {/* Remove Button - Positioned absolutely to not mess with layout, but accessible */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(index);
        }}
        className="absolute -top-2 -right-2 z-20 h-6 w-6 rounded-full bg-destructive text-destructive-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-all scale-90 hover:scale-100 flex items-center justify-center ring-2 ring-background"
        aria-label={`Remove ${image.filename}`}
      >
        <X className="h-3 w-3" />
      </button>

      {/* Minimal Info Area */}
      {optionMapping ? (
        <div className="min-w-0 px-0.5">
          <span
            className="inline-flex max-w-full items-center truncate rounded-md border border-secondary bg-secondary/50 px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
            title={optionMapping}
          >
            {optionMapping}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// --- Drag Item Overlay ---
function ItemOverlay({
  image,
  index,
  optionMapping,
}: {
  image: MediaFile;
  index: number;
  optionMapping?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-background shadow-xl ring-1 ring-border/50 scale-105 cursor-grabbing z-50 w-full max-w-[200px]">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-primary">
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.filename}
          className="h-full w-full object-cover shrink-0"
        />
        <div className="absolute inset-0 bg-primary/10" />

        {/* Always visible number on dragged item */}
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-4xl font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
            {index + 1}
          </span>
        </div>

        {/* Primary Badge (On Image) */}
        {index === 0 && (
          <div className="absolute bottom-2 left-2 right-auto pointer-events-none">
            <span className="bg-blue-600/90 backdrop-blur-[2px] text-white text-[10px] font-semibold px-2 py-0.5 rounded-full shadow-sm">
              Primary
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 px-1 pb-2">
        {optionMapping && (
          <span className="self-start inline-flex items-center px-1.5 py-0.5 rounded-md bg-secondary/50 border border-secondary text-[11px] font-medium text-secondary-foreground truncate">
            {optionMapping}
          </span>
        )}
      </div>
    </div>
  );
}

export function DraggableImageGallery({
  images,
  variantImageMappingByImageId = {},
  enableVariantImages,
  onImagesReorder,
  onImageRemove,
  maxVisible = 6,
}: DraggableImageGalleryProps) {
  // Local state for live dragging updates
  const [items, setItems] = useState(images);

  // Sync props to local state when not dragging
  // We use a ref to track if we are dragging to avoid overwriting state during drag
  // if parent updates for some reason (rare but possible)
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!isDraggingRef.current) {
      setItems(images);
    }
  }, [images]);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [expanded, setExpanded] = useState(false);

  const visibleImages = expanded ? items : items.slice(0, maxVisible);
  const hiddenCount = items.length - maxVisible;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
    isDraggingRef.current = true;
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    if (active.id !== over.id) {
      setItems((currentItems) => {
        const oldIndex = currentItems.findIndex(
          (item) => item.id === active.id,
        );
        const newIndex = currentItems.findIndex((item) => item.id === over.id);
        return arrayMove(currentItems, oldIndex, newIndex);
      });
    }
  };

  const handleDragEnd = (_: DragEndEvent) => {
    setActiveId(null);
    isDraggingRef.current = false;

    // items state is already updated by handleDragOver
    // Just sync to parent
    onImagesReorder(items);
  };

  const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
      styles: {
        active: {
          opacity: "0.2",
        },
      },
    }),
  };

  const activeItem = activeId ? items.find((img) => img.id === activeId) : null;
  // Get the *current* index of the active item in the live list
  const activeIndex = activeItem
    ? items.findIndex((img) => img.id === activeId)
    : -1;

  const activeOptionMapping =
    activeItem &&
    enableVariantImages
      ? variantImageMappingByImageId[activeItem.id]
      : undefined;

  // If option-image mapping is active, standard grid behavior usually works.
  // but standard grid behavior usually works.

  return (
    <div className="group/gallery space-y-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver} // Added onDragOver handler
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleImages.map((img) => img.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {visibleImages.map((image, index) => {
              const optionMapping =
                enableVariantImages
                  ? variantImageMappingByImageId[image.id]
                  : undefined;

              return (
                <SortableImage
                  key={image.id}
                  image={image}
                  index={index}
                  optionMapping={optionMapping}
                  onRemove={onImageRemove}
                />
              );
            })}
          </div>
        </SortableContext>

        {typeof document !== "undefined" &&
          createPortal(
            <DragOverlay dropAnimation={dropAnimation} className="z-100">
              {activeItem ? (
                <ItemOverlay
                  image={activeItem}
                  index={activeIndex}
                  optionMapping={activeOptionMapping}
                />
              ) : null}
            </DragOverlay>,
            document.body,
          )}
      </DndContext>

      {/* Show More / Show Less Button */}
      {items.length > maxVisible && (
        <div className="relative flex justify-center pt-4">
          {!expanded && (
            <div
              className="absolute inset-x-0 -top-12 bottom-1/2 bg-linear-to-b from-transparent to-background/90"
              pointer-events-none
            />
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="relative z-10 rounded-full px-6 gap-2 border-dashed border-muted-foreground/30 hover:border-primary/50 text-muted-foreground hover:text-foreground bg-background hover:bg-accent/50 transition-all font-normal shadow-sm"
          >
            {expanded ? (
              <>
                Show Less
                <ChevronUp className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                <ImageIcon className="h-3.5 w-3.5" />
                View {hiddenCount} More Images
                <ChevronDown className="h-3.5 w-3.5 opacity-50" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
