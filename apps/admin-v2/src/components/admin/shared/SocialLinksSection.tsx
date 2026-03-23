// src/components/admin/shared/SocialLinksSection.tsx
import React, { useMemo, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MediaManager } from "../media-manager";
import { Plus, Trash2, GripVertical, Link2, ImageIcon, X } from "lucide-react";
import { nanoid } from "nanoid";
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
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import type { SocialLink } from "./builder-types";
import type { MediaFile } from "@/components/admin/media-manager/types";

interface SocialLinksSectionProps {
  social: SocialLink[];
  onChange: (social: SocialLink[]) => void;
  droppableId: string;
  description?: string;
  cardClassName?: string;
}

const SortableSocialLink = React.memo(function SortableSocialLink({
  link,
  onUpdate,
  onRemove,
  onIconSelect,
  onIconRemove,
}: {
  link: SocialLink;
  onUpdate: (id: string, updates: Partial<SocialLink>) => void;
  onRemove: (id: string) => void;
  onIconSelect: (id: string, file: MediaFile) => void;
  onIconRemove: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: link.id });

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
    }),
    [transform, transition],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 p-2 border rounded-md bg-card",
        isDragging && "shadow-lg ring-2 ring-primary/30 opacity-50",
      )}
    >
      {/* Drag Handle */}
      <div
        {...attributes}
        {...listeners}
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
              onClick={() => onIconRemove(link.id)}
            >
              <X className="h-2 w-2" />
            </Button>
          </div>
        ) : (
          <MediaManager
            onSelect={(file) => onIconSelect(link.id, file)}
            trigger={
              <Button variant="outline" size="icon" className="h-9 w-9">
                <ImageIcon className="h-4 w-4" />
              </Button>
            }
          />
        )}
      </div>

      {/* Label Input */}
      <Input
        value={link.label}
        onChange={(e) => onUpdate(link.id, { label: e.target.value })}
        placeholder="Label"
        className="flex-1 h-9"
      />

      {/* URL Input */}
      <Input
        value={link.url}
        onChange={(e) => onUpdate(link.id, { url: e.target.value })}
        placeholder="URL"
        className="flex-1 h-9"
      />

      {/* Remove Button */}
      <Button
        size="icon"
        variant="ghost"
        onClick={() => onRemove(link.id)}
        className="h-9 w-9 shrink-0"
      >
        <Trash2 className="h-4 w-4 text-muted-foreground" />
      </Button>
    </div>
  );
});

export function SocialLinksSection({
  social,
  onChange,
  droppableId: _droppableId,
  description = "Add links to your social media profiles. Customize each with a label and optional icon.",
  cardClassName,
}: SocialLinksSectionProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Memoize social link IDs for SortableContext
  const socialIds = useMemo(() => social.map((link) => link.id), [social]);

  const addSocialLink = useCallback(() => {
    onChange([
      ...social,
      {
        id: nanoid(),
        label: "",
        url: "",
        iconUrl: undefined,
      },
    ]);
  }, [social, onChange]);

  const updateSocialLink = useCallback(
    (id: string, updates: Partial<SocialLink>) => {
      onChange(
        social.map((link) =>
          link.id === id ? { ...link, ...updates } : link,
        ),
      );
    },
    [social, onChange],
  );

  const removeSocialLink = useCallback(
    (id: string) => {
      onChange(social.filter((link) => link.id !== id));
    },
    [social, onChange],
  );

  const handleIconSelect = useCallback(
    (id: string, file: MediaFile) => {
      onChange(
        social.map((link) =>
          link.id === id ? { ...link, iconUrl: file.url } : link,
        ),
      );
    },
    [social, onChange],
  );

  const removeIcon = useCallback(
    (id: string) => {
      onChange(
        social.map((link) =>
          link.id === id ? { ...link, iconUrl: undefined } : link,
        ),
      );
    },
    [social, onChange],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = social.findIndex((link) => link.id === active.id);
      const newIndex = social.findIndex((link) => link.id === over.id);
      onChange(arrayMove(social, oldIndex, newIndex));
    },
    [social, onChange],
  );

  return (
    <Card className={cardClassName}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Social Links</CardTitle>
            <CardDescription>{description}</CardDescription>
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
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={socialIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {social.map((link) => (
                  <SortableSocialLink
                    key={link.id}
                    link={link}
                    onUpdate={updateSocialLink}
                    onRemove={removeSocialLink}
                    onIconSelect={handleIconSelect}
                    onIconRemove={removeIcon}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </CardContent>
    </Card>
  );
}
