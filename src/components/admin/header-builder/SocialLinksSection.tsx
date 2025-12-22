// src/components/admin/header-builder/SocialLinksSection.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MediaManager } from "../MediaManager";
import { Plus, Trash2, GripVertical, Link2, ImageIcon, X } from "lucide-react";
import { nanoid } from "nanoid";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
import type { SocialLink, MediaFile } from "./types";

interface SocialLinksSectionProps {
  social: SocialLink[];
  onChange: (social: SocialLink[]) => void;
}

export function SocialLinksSection({
  social,
  onChange,
}: SocialLinksSectionProps) {
  const addSocialLink = () => {
    onChange([
      ...social,
      {
        id: nanoid(),
        label: "",
        url: "",
        iconUrl: undefined,
      },
    ]);
  };

  const updateSocialLink = (id: string, updates: Partial<SocialLink>) => {
    onChange(
      social.map((link) => (link.id === id ? { ...link, ...updates } : link)),
    );
  };

  const removeSocialLink = (id: string) => {
    onChange(social.filter((link) => link.id !== id));
  };

  const handleIconSelect = (id: string, file: MediaFile) => {
    updateSocialLink(id, { iconUrl: file.url });
  };

  const removeIcon = (id: string) => {
    updateSocialLink(id, { iconUrl: undefined });
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const items = Array.from(social);
    const [reordered] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reordered);
    onChange(items);
  };

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Social Links</CardTitle>
            <CardDescription>
              Add links to your social media profiles. Customize each with a
              label and optional icon.
            </CardDescription>
          </div>
          <Button size="sm" onClick={addSocialLink} variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add Link
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {social.length === 0 ? (
          <div className="text-center py-8 border-2 border-dashed rounded-lg text-muted-foreground">
            <Link2 className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm font-medium mb-1">No social links added</p>
            <p className="text-xs mb-4">
              Add your first social media link to get started
            </p>
            <Button size="sm" onClick={addSocialLink}>
              <Plus className="h-4 w-4 mr-2" />
              Add First Link
            </Button>
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="header-social-links">
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn(
                    "space-y-2",
                    snapshot.isDraggingOver &&
                      "bg-primary/5 rounded-lg p-2 -m-2",
                  )}
                >
                  {social.map((link, index) => (
                    <Draggable
                      key={link.id}
                      draggableId={link.id}
                      index={index}
                    >
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={cn(
                            "flex items-center gap-2 p-2 border rounded-md bg-card",
                            snapshot.isDragging &&
                              "shadow-lg ring-2 ring-primary/30",
                          )}
                        >
                          {/* Drag Handle */}
                          <div
                            {...provided.dragHandleProps}
                            className="cursor-grab p-1 rounded hover:bg-muted shrink-0"
                          >
                            <GripVertical className="h-4 w-4 text-muted-foreground" />
                          </div>

                          {/* Icon Preview/Upload - Conditional rendering */}
                          <div className="relative shrink-0">
                            {link.iconUrl ? (
                              <div className="relative group">
                                <div className="h-9 w-9 rounded border bg-muted/30 flex items-center justify-center overflow-hidden">
                                  <img
                                    src={getOptimizedImageUrl(link.iconUrl)}
                                    alt={link.label || "Icon"}
                                    className="h-5 w-5 object-contain"
                                  />
                                </div>
                                <Button
                                  variant="destructive"
                                  size="icon"
                                  className="absolute -top-1 -right-1 h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity"
                                  onClick={() => removeIcon(link.id)}
                                >
                                  <X className="h-2 w-2" />
                                </Button>
                              </div>
                            ) : (
                              <MediaManager
                                onSelect={(file) =>
                                  handleIconSelect(link.id, file)
                                }
                                trigger={
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9"
                                  >
                                    <ImageIcon className="h-4 w-4" />
                                  </Button>
                                }
                              />
                            )}
                          </div>

                          {/* Label Input */}
                          <Input
                            value={link.label}
                            onChange={(e) =>
                              updateSocialLink(link.id, {
                                label: e.target.value,
                              })
                            }
                            placeholder="Label"
                            className="flex-1 h-9"
                          />

                          {/* URL Input */}
                          <Input
                            value={link.url}
                            onChange={(e) =>
                              updateSocialLink(link.id, { url: e.target.value })
                            }
                            placeholder="URL"
                            className="flex-1 h-9"
                          />

                          {/* Remove Button */}
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => removeSocialLink(link.id)}
                            className="h-9 w-9 shrink-0"
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
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
      </CardContent>
    </Card>
  );
}
