// Ultra-lightweight media card optimized for large images

import React, { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckCircle2,
  Trash2,
  ZoomIn,
  Download,
  Link as LinkIcon,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MediaFile } from "../types";
import { formatFileSize, formatDate } from "../utils";
import { toast } from "@/hooks/use-toast";
import { getOptimizedImageUrl, getOriginalImageUrl } from "@/lib/image-optimizer";

interface MediaCardProps {
  file: MediaFile;
  isSelected: boolean;
  selectionMode: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onPreview: (e: React.MouseEvent) => void;
  onToggleSelection: () => void;
}

export function MediaCard({
  file,
  isSelected,
  selectionMode,
  onSelect,
  onDelete,
  onPreview,
  onToggleSelection,
}: MediaCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Intersection Observer for true lazy loading
  useEffect(() => {
    if (!cardRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShouldLoad(true);
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: "50px", // Start loading 50px before visible
      }
    );

    observer.observe(cardRef.current);

    return () => observer.disconnect();
  }, []);

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Always copy the original URL, not the optimized version
      const originalUrl = getOriginalImageUrl(file.url);
      await navigator.clipboard.writeText(originalUrl);
      toast({
        title: "URL Copied",
        description: "Original image URL has been copied to clipboard.",
      });
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Could not copy URL to clipboard.",
        variant: "destructive",
      });
    }
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Always download the original file, not the optimized version
    const originalUrl = getOriginalImageUrl(file.url);
    const link = document.createElement("a");
    link.href = originalUrl;
    link.download = file.filename;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({
      title: "Download Started",
      description: `Downloading ${file.filename}...`,
    });
  };

  return (
    <Card
      ref={cardRef}
      className={`relative cursor-pointer ${
        selectionMode && isSelected
          ? "ring-2 ring-primary"
          : ""
      }`}
      onClick={selectionMode ? onToggleSelection : onSelect}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selectionMode) {
            onToggleSelection();
          } else {
            onSelect();
          }
        }
      }}
    >
      <CardContent className="p-2 relative">
        {/* Checkbox for selection mode */}
        {selectionMode && (
          <div
            className="absolute left-2 top-2 z-10 rounded-md bg-background/90 p-0.5 shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelection();
            }}
          >
            <Checkbox checked={isSelected} className="h-4 w-4" />
          </div>
        )}

        <div className="relative aspect-square overflow-hidden rounded-md bg-muted/30">
          {/* Simple loading background */}
          {!imageLoaded && !imageError && shouldLoad && (
            <div className="absolute inset-0 bg-muted/40" />
          )}

          {/* Placeholder before loading starts */}
          {!shouldLoad && (
            <div className="absolute inset-0 bg-muted/30" />
          )}

          {/* Error state */}
          {imageError && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/20">
              <div className="text-center text-muted-foreground">
                <svg className="h-8 w-8 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-xs">Failed to load</p>
              </div>
            </div>
          )}

          {/* Ultra-lightweight image - only load when visible */}
          {shouldLoad && (
            <img
              ref={imgRef}
              src={getOptimizedImageUrl(file.url)}
              alt={file.filename}
              className={`h-full w-full object-cover ${
                imageLoaded ? "opacity-100" : "opacity-0"
              }`}
              loading="lazy"
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => {
                setImageError(true);
                console.error(`Failed to load image: ${file.filename}`);
              }}
              // Critical: constrain rendering size
              style={{
                maxWidth: "300px",
                maxHeight: "300px",
                willChange: "auto", // Prevent GPU layers
              }}
            />
          )}

          {/* Simplified actions - only show when loaded */}
          {imageLoaded && !imageError && (
            <div className="absolute inset-0 flex opacity-0 hover:opacity-100 bg-black/50">
              <div className="absolute bottom-2 right-2 flex gap-1">
                {/* Preview button */}
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-7 w-7 bg-background/90 rounded-full"
                  onClick={onPreview}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>

                {/* More actions */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="h-7 w-7 bg-background/90 rounded-full"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={handleCopyUrl}>
                      <LinkIcon className="mr-2 h-4 w-4" />
                      Copy URL
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDownload}>
                      <Download className="mr-2 h-4 w-4" />
                      Download
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Selected indicator */}
              {selectionMode && isSelected && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <CheckCircle2 className="h-10 w-10 text-primary" />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-2 space-y-px">
          <p className="truncate text-xs font-medium" title={file.filename}>
            {file.filename}
          </p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatFileSize(file.size)}</span>
            <span className="text-[10px]">{formatDate(file.createdAt)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
