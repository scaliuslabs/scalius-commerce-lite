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
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import type { SocialLink } from "./builder-types";
import type { MediaFile } from "@/components/admin/media-manager/types";
import { getSortableStyle } from "./sortable-style";

interface SocialLinksSectionProps {
  social: SocialLink[];
  onChange: (social: SocialLink[]) => void;
  droppableId: string;
  description?: string;
  cardClassName?: string;
}

const MAX_SOCIAL_LINKS = 8;

export function isSafeSocialDestination(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
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
    () => getSortableStyle(transform, transition),
    [transform, transition],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "grid grid-cols-[28px_36px_minmax(100px,1fr)_32px] items-center gap-2 rounded-md border bg-card p-1.5 sm:grid-cols-[28px_36px_minmax(110px,0.7fr)_minmax(180px,1.3fr)_32px]",
        isDragging && "shadow-lg ring-2 ring-primary/30 opacity-50",
      )}
    >
      {/* Drag Handle */}
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab rounded p-1 hover:bg-muted shrink-0"
        aria-label={`Reorder ${link.label || "social link"}`}
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
              type="button"
              aria-label={`Remove icon from ${link.label || "social link"}`}
              onClick={() => onIconRemove(link.id)}
            >
              <X className="h-2 w-2" />
            </Button>
          </div>
        ) : (
          <MediaManager
            capability="image"
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
        className="h-8 min-w-0"
        aria-label="Social link label"
      />

      {/* URL Input */}
      <Input
        value={link.url}
        onChange={(e) => onUpdate(link.id, { url: e.target.value })}
        placeholder="https://…"
        className={cn(
          "col-span-3 col-start-2 h-8 min-w-0 sm:col-auto",
          link.url && !isSafeSocialDestination(link.url) && "border-destructive focus-visible:ring-destructive",
        )}
        aria-label={`${link.label || "Social"} destination`}
        aria-invalid={Boolean(link.url && !isSafeSocialDestination(link.url))}
        type="url"
      />

      {/* Remove Button */}
      <Button
        size="icon"
        variant="ghost"
        type="button"
        onClick={() => onRemove(link.id)}
        className="row-start-1 col-start-4 h-8 w-8 shrink-0 sm:col-auto sm:row-auto"
        aria-label={`Remove ${link.label || "social link"}`}
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
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Social links</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Button size="sm" onClick={addSocialLink} variant="outline" disabled={social.length >= MAX_SOCIAL_LINKS}>
            <Plus className="h-4 w-4 mr-2" />
            Add Link
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {social.length === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-4 text-muted-foreground">
            <div className="flex items-center gap-3">
              <Link2 className="h-5 w-5 opacity-50" />
              <p className="text-sm">No social links</p>
            </div>
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
              <div className="space-y-1.5">
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
        <p className="mt-2 text-xs text-muted-foreground">
          Up to {MAX_SOCIAL_LINKS} credential-free HTTPS destinations. Icons are optional.
        </p>
      </CardContent>
    </Card>
  );
}
