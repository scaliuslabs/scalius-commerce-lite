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
import { translate, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";

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
  title: z.string().min(1, { error: () => translate(productMessages, "sectionTitleRequired") }),
  content: z.string().min(10, { error: () => translate(productMessages, "sectionContentShort") }),
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
  const t = useMessages(productMessages);
  const name = item.title || t("untitledSection");
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
    // eslint-disable-next-line shadcn/no-inline-styles -- dnd-kit moves the dragged row with a live transform.
    <div ref={setNodeRef} style={style} className="space-y-2 py-3">
      <Form {...form}>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="cursor-grab"
            {...attributes}
            {...listeners}
            aria-label={t("reorderSection", { name })}
          >
            <GripVertical className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onExpandedChange(!isExpanded)}
            aria-expanded={isExpanded}
            aria-label={t("toggleSection", { name })}
          >
            <ChevronDown className={cn("h-4 w-4", !isExpanded && "-rotate-90")} />
          </Button>
          <div className="min-w-0 flex-1">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem className="mb-0">
                  <FormControl>
                    <Input placeholder={t("sectionTitlePlaceholder")} {...field} />
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
            onClick={() => onRemove(item.id)}
            aria-label={t("removeSection", { name })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        {isExpanded && (
          <div>
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
                      placeholder={t("sectionContentPlaceholder")}
                      ariaLabel={t("sectionContent", { name })}
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
  );
}

export function AdditionalInfoManager({
  initialContent,
  onContentChange,
}: AdditionalInfoManagerProps) {
  const t = useMessages(productMessages);
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
      <p className="text-body text-muted-foreground">{t("loading")}</p>
    );
  }

  return (
    <div className="space-y-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="divide-y">
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
          </div>
        </SortableContext>
      </DndContext>

      <Button type="button" variant="outline" size="sm" onClick={handleAddItem}>
        <Plus className="mr-2 h-4 w-4" />
        {t("addSection")}
      </Button>
    </div>
  );
}
