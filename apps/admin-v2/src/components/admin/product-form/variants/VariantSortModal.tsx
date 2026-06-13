// src/components/admin/ProductForm/variants/VariantSortModal.tsx

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2 } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getVariantSortOrder,
  updateVariantSortOrder,
} from "@/lib/api-functions/products";

interface VariantSortModalProps {
  productId: string;
  isOpen: boolean;
  onClose: () => void;
  onSortUpdated: () => void;
}

interface SortItem {
  value: string;
  sortOrder: number;
}

function SortableVariantItem({
  item,
  index,
  label,
}: {
  item: SortItem;
  index: number;
  label: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.value });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "flex items-center gap-3 p-3 bg-muted/50 rounded-md border cursor-grab active:cursor-grabbing",
        isDragging && "shadow-lg ring-2 ring-primary bg-background opacity-50",
      )}
    >
      <GripVertical className="h-5 w-5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{item.value}</div>
        <div className="text-xs text-muted-foreground">
          {label}: {index + 1}
        </div>
      </div>
      <div className="text-sm text-muted-foreground shrink-0">
        #{index + 1}
      </div>
    </div>
  );
}

export function VariantSortModal({
  productId,
  isOpen,
  onClose,
  onSortUpdated,
}: VariantSortModalProps) {
  const [colors, setColors] = useState<SortItem[]>([]);
  const [sizes, setSizes] = useState<SortItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const fetchSortOrder = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getVariantSortOrder({ data: { productId } });
      setColors(data.colors);
      setSizes(data.sizes);
    } catch (error: unknown) {
      console.error("Failed to fetch sort order:", error);
      toast.error("Error", { description: "Failed to load variant sort order" });
    } finally {
      setIsLoading(false);
    }
  }, [productId]);

  // Fetch current sort order
  useEffect(() => {
    if (isOpen) {
      fetchSortOrder();
    }
  }, [isOpen, fetchSortOrder]);

  const handleColorDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = colors.findIndex((c) => c.value === active.id);
    const newIndex = colors.findIndex((c) => c.value === over.id);
    const reordered = arrayMove(colors, oldIndex, newIndex).map(
      (item, index) => ({ ...item, sortOrder: index }),
    );
    setColors(reordered);
  };

  const handleSizeDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sizes.findIndex((s) => s.value === active.id);
    const newIndex = sizes.findIndex((s) => s.value === over.id);
    const reordered = arrayMove(sizes, oldIndex, newIndex).map(
      (item, index) => ({ ...item, sortOrder: index }),
    );
    setSizes(reordered);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateVariantSortOrder({ data: { productId, colors, sizes } });
      toast.success("Success", { description: "Variant sort order updated successfully" });
      onSortUpdated();
      onClose();
    } catch (error: unknown) {
      console.error("Failed to save sort order:", error);
      toast.error("Error", { description: getServerFnError(error, "Failed to update variant sort order") });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Reorder Variant Values</DialogTitle>
          <DialogDescription>
            Drag and drop to reorder colors and sizes. This affects the display
            order in the storefront.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs
            defaultValue="colors"
            className="flex-1 overflow-hidden flex flex-col"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="colors">
                Colors {colors.length > 0 && `(${colors.length})`}
              </TabsTrigger>
              <TabsTrigger value="sizes">
                Sizes {sizes.length > 0 && `(${sizes.length})`}
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="colors"
              className="flex-1 overflow-auto mt-4 pr-2"
            >
              {colors.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No color variants found
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleColorDragEnd}
                >
                  <SortableContext
                    items={colors.map((c) => c.value)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2 min-h-[100px]">
                      {colors.map((color, index) => (
                        <SortableVariantItem
                          key={color.value}
                          item={color}
                          index={index}
                          label="Image position"
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </TabsContent>

            <TabsContent
              value="sizes"
              className="flex-1 overflow-auto mt-4 pr-2"
            >
              {sizes.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No size variants found
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleSizeDragEnd}
                >
                  <SortableContext
                    items={sizes.map((s) => s.value)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2 min-h-[100px]">
                      {sizes.map((size, index) => (
                        <SortableVariantItem
                          key={size.value}
                          item={size}
                          index={index}
                          label="Display order"
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading || isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
