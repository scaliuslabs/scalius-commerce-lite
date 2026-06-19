import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { SlideRow } from "./SlideRow";
import type { SliderImage } from "./helpers";

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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const dragHandle = (
    <div
      {...attributes}
      {...listeners}
      className="shrink-0 flex items-center justify-center w-full md:w-8 text-muted-foreground/50 hover:text-foreground cursor-grab active:cursor-grabbing rounded-md hover:bg-muted/50 transition-colors self-stretch"
    >
      <GripVertical className="w-5 h-5 md:rotate-0 rotate-90" />
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
