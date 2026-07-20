// src/components/admin/header-builder/BrandingSection.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { MediaManager } from "../media-manager";
import { Trash2, AlertCircle } from "lucide-react";
import type { LogoConfig, FaviconConfig, MediaFile } from "./types";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";

interface BrandingSectionProps {
  logo: LogoConfig;
  favicon: FaviconConfig;
  onLogoChange: (logo: LogoConfig) => void;
  onFaviconChange: (favicon: FaviconConfig) => void;
}

export function BrandingSection({
  logo,
  favicon,
  onLogoChange,
  onFaviconChange,
}: BrandingSectionProps) {
  const handleLogoSelect = (file: MediaFile) => {
    onLogoChange({ src: file.url, alt: file.filename || "Site Logo" });
  };

  const removeLogo = () => {
    onLogoChange({ src: "", alt: "" });
  };

  const handleFaviconSelect = (file: MediaFile) => {
    onFaviconChange({ src: file.url, alt: file.filename || "Site Favicon" });
  };

  const removeFavicon = () => {
    onFaviconChange({ src: "", alt: "" });
  };

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {/* Logo Section */}
      <Card className="border border-border shadow-sm">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-base">Logo</CardTitle>
          <CardDescription>
            Shown in desktop and mobile navigation.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 items-start">
            <div className="flex flex-col items-center justify-center space-y-2">
              <Label className="text-xs font-medium">Preview</Label>
              {logo.src ? (
                <div className="relative group border border-border rounded-md p-2 bg-muted/30 w-full aspect-2/1 flex items-center justify-center">
                  <img
                    src={getOptimizedImageUrl(
                      logo.src,
                      ADMIN_IMAGE_PRESETS.brandLogo,
                    )}
                    alt={logo.alt || "Logo preview"}
                    className="max-h-full max-w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shadow-md rounded-full z-10"
                    onClick={removeLogo}
                    title="Remove logo"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="border border-dashed border-border rounded-md p-2 bg-muted/30 w-full aspect-2/1 flex items-center justify-center text-xs text-muted-foreground font-medium">
                  No logo
                </div>
              )}
            </div>
            <div className="space-y-3">
              <MediaManager
                capability="image"
                onSelect={handleLogoSelect}
                triggerLabel={logo.src ? "Change Logo" : "Select Logo Image"}
              />
              {!logo.src && (
                <Alert variant="destructive" className="px-3 py-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Logo required</AlertTitle>
                  <AlertDescription>
                    Select an image before saving.
                  </AlertDescription>
                </Alert>
              )}
              <Input
                value={logo.alt}
                onChange={(e) => onLogoChange({ ...logo, alt: e.target.value })}
                placeholder="Logo description for screen readers"
                className="h-9"
                disabled={!logo.src}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Favicon Section */}
      <Card className="border border-border shadow-sm">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-base">Browser icon</CardTitle>
          <CardDescription>
            A square mark for tabs and bookmarks.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 items-start">
            <div className="flex flex-col items-center justify-center space-y-2">
              <Label className="text-xs font-medium">
                Preview
              </Label>
              {favicon.src ? (
                <div className="relative group border border-border rounded-md p-2 bg-muted/30 h-20 w-20 flex items-center justify-center mx-auto">
                  <img
                    src={getOptimizedImageUrl(
                      favicon.src,
                      ADMIN_IMAGE_PRESETS.favicon,
                    )}
                    alt={favicon.alt || "Favicon preview"}
                    className="h-10 w-10 object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-2 -right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shadow-md rounded-full z-10"
                    onClick={removeFavicon}
                    title="Remove favicon"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="border border-dashed border-border rounded-md p-2 bg-muted/30 h-20 w-20 flex items-center justify-center text-xs text-muted-foreground font-medium mx-auto">
                  No icon
                </div>
              )}
            </div>
            <div className="space-y-3">
              <MediaManager
                capability="image"
                onSelect={handleFaviconSelect}
                triggerLabel={
                  favicon.src ? "Change Favicon" : "Select Favicon Image"
                }
              />
              <Input
                value={favicon.alt}
                onChange={(e) =>
                  onFaviconChange({ ...favicon, alt: e.target.value })
                }
                placeholder="Icon description"
                className="h-9"
                disabled={!favicon.src}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
