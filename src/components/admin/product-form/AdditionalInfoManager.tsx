// src/components/admin/product-form/AdditionalInfoManager.tsx
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TiptapEditor } from "@/components/ui/tiptap-editor";
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
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";


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
  onUpdate,
  onRemove,
}: {
  item: RichContentItem;
  onUpdate: (id: string, data: Partial<RichContentItem>) => void;
  onRemove: (id: string) => void;
}) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

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
            <div
              {...attributes}
              {...listeners}
              className="cursor-grab p-1 text-muted-foreground hover:bg-muted rounded"
            >
              <GripVertical className="h-4 w-4" />
            </div>
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1 hover:bg-muted rounded"
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
                        className="h-7 text-xs border-0 shadow-none px-2 focus-visible:ring-0"
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
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onRemove(item.id)}
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
                      <TiptapEditor
                        content={field.value || ""}
                        onChange={(newContent: string) => {
                          field.onChange(newContent);
                          onUpdate(item.id, { content: newContent });
                        }}
                        placeholder="Add content for this section..."
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
  const [items, setItems] = React.useState<RichContentItem[]>([]);
  const [isClient, setIsClient] = React.useState(false);

  React.useEffect(() => {
    setIsClient(true);
    setItems(initialContent.map(item => ({ ...item, id: item.id || `item-${nanoid()}` })));
  }, [initialContent]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const triggerChange = (newItems: RichContentItem[]) => {
    onContentChange(newItems);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (active.id !== over?.id) {
      setItems((currentItems) => {
        const oldIndex = currentItems.findIndex((item) => item.id === active.id);
        const newIndex = currentItems.findIndex((item) => item.id === over?.id);
        const newOrderedItems = arrayMove(currentItems, oldIndex, newIndex);
        triggerChange(newOrderedItems);
        return newOrderedItems;
      });
    }
  };

  const handleAddItem = () => {
    const newItem: RichContentItem = {
      id: `item-${nanoid()}`,
      title: "",
      content: "",
    };
    const newItems = [...items, newItem];
    setItems(newItems);
    triggerChange(newItems);
  };

  const handleUpdateItem = React.useCallback((id: string, data: Partial<RichContentItem>) => {
    setItems((currentItems) => {
      const newItems = currentItems.map((item) =>
        item.id === id ? { ...item, ...data } : item
      );
      triggerChange(newItems);
      return newItems;
    });
  }, [onContentChange]);

  const handleRemoveItem = React.useCallback((id: string) => {
    setItems((currentItems) => {
      const newItems = currentItems.filter((item) => item.id !== id);
      triggerChange(newItems);
      return newItems;
    });
  }, [onContentChange]);

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
              onUpdate={handleUpdateItem}
              onRemove={handleRemoveItem}
            />
          ))}
        </SortableContext>
      </DndContext>

      {items.length === 0 && (
        <div className="text-center py-6 px-4 border border-dashed rounded-md">
          <p className="text-xs text-muted-foreground">
            No sections yet. Click below to add.
          </p>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAddItem}
        className="w-full h-8 text-xs"
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add Section
      </Button>
    </div>
  );
}