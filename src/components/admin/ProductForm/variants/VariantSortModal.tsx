// src/components/admin/ProductForm/variants/VariantSortModal.tsx

import { useState, useEffect } from "react";
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
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { GripVertical, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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

export function VariantSortModal({
  productId,
  isOpen,
  onClose,
  onSortUpdated,
}: VariantSortModalProps) {
  const { toast } = useToast();
  const [colors, setColors] = useState<SortItem[]>([]);
  const [sizes, setSizes] = useState<SortItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch current sort order
  useEffect(() => {
    if (isOpen) {
      fetchSortOrder();
    }
  }, [isOpen, productId]);

  const fetchSortOrder = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/products/${productId}/variants/sort-order`,
      );
      if (response.ok) {
        const data = await response.json();
        setColors(data.colors || []);
        setSizes(data.sizes || []);
      }
    } catch (error) {
      console.error("Failed to fetch sort order:", error);
      toast({
        title: "Error",
        description: "Failed to load variant sort order",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleColorDragEnd = (result: any) => {
    if (!result.destination) return;

    const items = Array.from(colors);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update sort orders
    const updatedItems = items.map((item, index) => ({
      ...item,
      sortOrder: index,
    }));

    setColors(updatedItems);
  };

  const handleSizeDragEnd = (result: any) => {
    if (!result.destination) return;

    const items = Array.from(sizes);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);

    // Update sort orders
    const updatedItems = items.map((item, index) => ({
      ...item,
      sortOrder: index,
    }));

    setSizes(updatedItems);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/products/${productId}/variants/sort-order`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            colors,
            sizes,
          }),
        },
      );

      if (response.ok) {
        toast({
          title: "Success",
          description: "Variant sort order updated successfully",
        });
        onSortUpdated();
        onClose();
      } else {
        throw new Error("Failed to update sort order");
      }
    } catch (error) {
      console.error("Failed to save sort order:", error);
      toast({
        title: "Error",
        description: "Failed to update variant sort order",
        variant: "destructive",
      });
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
                <DragDropContext onDragEnd={handleColorDragEnd}>
                  <Droppable droppableId="colors">
                    {(provided) => (
                      <div
                        {...provided.droppableProps}
                        ref={provided.innerRef}
                        className="space-y-2 min-h-[100px]"
                      >
                        {colors.map((color, index) => (
                          <Draggable
                            key={color.value}
                            draggableId={color.value}
                            index={index}
                          >
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                className={cn(
                                  "flex items-center gap-3 p-3 bg-muted/50 rounded-md border cursor-grab active:cursor-grabbing",
                                  snapshot.isDragging &&
                                    "shadow-lg ring-2 ring-primary bg-background",
                                )}
                                style={{
                                  ...provided.draggableProps.style,
                                  left: "auto !important",
                                  top: "auto !important",
                                }}
                              >
                                <GripVertical className="h-5 w-5 text-muted-foreground shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">
                                    {color.value}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Image position: {index + 1}
                                  </div>
                                </div>
                                <div className="text-sm text-muted-foreground shrink-0">
                                  #{index + 1}
                                </div>
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
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
                <DragDropContext onDragEnd={handleSizeDragEnd}>
                  <Droppable droppableId="sizes">
                    {(provided) => (
                      <div
                        {...provided.droppableProps}
                        ref={provided.innerRef}
                        className="space-y-2 min-h-[100px]"
                      >
                        {sizes.map((size, index) => (
                          <Draggable
                            key={size.value}
                            draggableId={size.value}
                            index={index}
                          >
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                className={cn(
                                  "flex items-center gap-3 p-3 bg-muted/50 rounded-md border cursor-grab active:cursor-grabbing",
                                  snapshot.isDragging &&
                                    "shadow-lg ring-2 ring-primary bg-background",
                                )}
                                style={{
                                  ...provided.draggableProps.style,
                                  left: "auto !important",
                                  top: "auto !important",
                                }}
                              >
                                <GripVertical className="h-5 w-5 text-muted-foreground shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">
                                    {size.value}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    Display order: {index + 1}
                                  </div>
                                </div>
                                <div className="text-sm text-muted-foreground shrink-0">
                                  #{index + 1}
                                </div>
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
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
