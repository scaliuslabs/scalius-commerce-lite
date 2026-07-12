import { useSortable } from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { SlideRow } from "./SlideRow";
import type { SliderImage } from "./helpers";
import { getSortableStyle } from "../shared/sortable-style";

interface SortableSlideProps {
  image: SliderImage;
  index: number;
  type: "desktop" | "mobile";
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SliderImage>) => void;
}

export function SortableSlide({
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

  const style = getSortableStyle(transform, transition);

  const dragHandle = (
    <div
      {...attributes}
      {...listeners}
      className="flex w-7 shrink-0 cursor-grab items-center justify-center self-stretch rounded text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground active:cursor-grabbing"
      aria-label={`Reorder slide ${index + 1}`}
    >
      <GripVertical className="h-4 w-4" />
    </div>
  );

  return (
    <SlideRow
      rowRef={setNodeRef}
      style={style}
      image={image}
      index={index}
      type={type}
      onRemove={onRemove}
      onUpdate={onUpdate}
      isDragging={isDragging}
      dragHandle={dragHandle}
    />
  );
}
