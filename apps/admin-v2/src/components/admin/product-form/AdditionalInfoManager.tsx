// src/components/admin/product-form/AdditionalInfoManager.tsx
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { nanoid } from "nanoid";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DeferredTiptapEditor } from "~/components/ui/tiptap/DeferredTiptapEditor";
import { Plus, Trash2, GripVertical, ChevronDown } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@scalius/shared/utils";
import { Form, FormControl, FormField, FormItem, FormMessage } from "~/components/ui/form";
import { getSortableStyle } from "../shared/sortable-style";


export interface RichContentItem {
  id: string;
  title: string;
  content: string;
}

interface AdditionalInfoManagerProps {
  initialContent: RichContentItem[];
  onContentChange: (content: RichContentItem[]) => void;
}

const itemSchema = z.object({
  title: z.string().min(1, "Title is required."),
  content: z.string().min(10, "Content must be at least 10 characters."),
});

function SortableRichContentItem({
  item,
  isExpanded,
  onExpandedChange,
  onUpdate,
  onRemove,
}: {
  item: RichContentItem;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onUpdate: (id: string, data: Partial<RichContentItem>) => void;
  onRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: item.id });

  const style = getSortableStyle(transform, transition);

  const form = useForm<{ title: string; content: string }>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      title: item.title,
      content: item.content,
    },
  });

  React.useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === "title") {
        onUpdate(item.id, { title: value.title });
      }
    });
    return () => subscription.unsubscribe();
  }, [form, item.id, onUpdate]);

  return (
    <div ref={setNodeRef} style={style} className="mb-2">
      <div className="border rounded-md bg-card">
        <Form {...form}>
          <div className="flex items-center gap-2 px-2 py-2 border-b">
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="flex h-11 w-11 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted md:h-7 md:w-7"
              aria-label={`Reorder ${item.title || "untitled section"}`}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onExpandedChange(!isExpanded)}
              className="flex h-11 w-11 items-center justify-center rounded hover:bg-muted md:h-7 md:w-7"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.title || "untitled section"}`}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", !isExpanded && "-rotate-90")} />
            </button>
            <div className="flex-1">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="mb-0">
                    <FormControl>
                      <Input
                        placeholder="Section title (e.g., Specifications)"
                        {...field}
                        className="min-h-11 border-0 px-2 text-xs shadow-none focus-visible:ring-0 md:h-7 md:min-h-7"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 text-destructive hover:text-destructive md:h-7 md:w-7"
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.title || "untitled section"}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          {isExpanded && (
            <div className="p-3">
              <FormField
                control={form.control}
                name="content"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <DeferredTiptapEditor
                        content={field.value || ""}
                        onChange={(newContent: string) => {
                          field.onChange(newContent);
                          onUpdate(item.id, { content: newContent });
                        }}
                        placeholder="Add content for this section..."
                        ariaLabel={`Additional section content: ${item.title || "Untitled section"}`}
                        compact={true}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
        </Form>
      </div>
    </div>
  );
}

export function AdditionalInfoManager({
  initialContent,
  onContentChange,
}: AdditionalInfoManagerProps) {
  const [isClient, setIsClient] = React.useState(false);
  const [expandedItemId, setExpandedItemId] = React.useState<string | null>(null);
  const items = React.useMemo(
    () => initialContent.map((item, index) => ({
      ...item,
      id: item.id || `legacy-section-${index}`,
    })),
    [initialContent],
  );

  React.useEffect(() => {
    setIsClient(true);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const triggerChange = React.useCallback((newItems: RichContentItem[]) => {
    onContentChange(newItems);
  }, [onContentChange]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      const oldIndex = items.findIndex((item) => item.id === active.id);
      const newIndex = items.findIndex((item) => item.id === over?.id);
      if (oldIndex < 0 || newIndex < 0) return;
      triggerChange(arrayMove(items, oldIndex, newIndex));
    }
  };

  const handleAddItem = () => {
    const newItem: RichContentItem = {
      id: `item-${nanoid()}`,
      title: "",
      content: "",
    };
    const newItems = [...items, newItem];
    setExpandedItemId(newItem.id);
    triggerChange(newItems);
  };

  const handleUpdateItem = React.useCallback((id: string, data: Partial<RichContentItem>) => {
    triggerChange(items.map((item) =>
      item.id === id ? { ...item, ...data } : item
    ));
  }, [items, triggerChange]);

  const handleRemoveItem = React.useCallback((id: string) => {
    setExpandedItemId((currentId) => currentId === id ? null : currentId);
    triggerChange(items.filter((item) => item.id !== id));
  }, [items, triggerChange]);

  if (!isClient) {
    return (
      <div className="p-4 border rounded-lg">
        <p className="text-muted-foreground">Loading additional fields...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <SortableRichContentItem
              key={item.id}
              item={item}
              isExpanded={expandedItemId === item.id}
              onExpandedChange={(expanded) => {
                setExpandedItemId(expanded ? item.id : null);
              }}
              onUpdate={handleUpdateItem}
              onRemove={handleRemoveItem}
            />
          ))}
        </SortableContext>
      </DndContext>

      {items.length === 0 && (
        <div className="text-center py-6 px-4 border border-dashed rounded-md">
          <p className="text-xs text-muted-foreground">
            No additional sections.
          </p>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAddItem}
        className="min-h-11 w-full text-xs md:h-8 md:min-h-8"
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add section
      </Button>
    </div>
  );
}
