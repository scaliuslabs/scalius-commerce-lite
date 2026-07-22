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
import { Trash2, AlertCircle, Upload } from "lucide-react";
import type { LogoConfig, FaviconConfig, MediaFile } from "./types";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";

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
  const logoWidth = logo.width ?? HEADER_LOGO_WIDTH_DEFAULT;
  const logoPreviewWidth = Math.round((logoWidth / HEADER_LOGO_WIDTH_MAX) * 104);

  const handleLogoSelect = (file: MediaFile) => {
    onLogoChange({
      ...logo,
      src: file.url,
      alt: file.filename || "Site Logo",
    });
  };

  const removeLogo = () => {
    onLogoChange({ ...logo, src: "", alt: "" });
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
                    style={{ maxWidth: logoPreviewWidth }}
                    loading="lazy"
                    decoding="async"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -right-2 -top-2 z-10 h-11 w-11 rounded-full opacity-100 shadow-md transition-opacity sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    onClick={removeLogo}
                    title="Remove logo"
                    aria-label="Remove logo"
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
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full sm:h-10"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {logo.src ? "Change logo" : "Choose logo"}
                  </Button>
                }
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
              <div className="space-y-1.5">
                <Label htmlFor="header-logo-alt" className="text-xs">
                  Alternative text
                </Label>
                <Input
                  id="header-logo-alt"
                  value={logo.alt}
                  onChange={(e) =>
                    onLogoChange({ ...logo, alt: e.target.value })
                  }
                  placeholder="Describe the logo"
                  className="h-11 sm:h-9"
                  disabled={!logo.src}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="header-logo-width" className="text-xs">
                    Logo width
                  </Label>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {logoWidth}px
                  </span>
                </div>
                <input
                  id="header-logo-width"
                  type="range"
                  min={HEADER_LOGO_WIDTH_MIN}
                  max={HEADER_LOGO_WIDTH_MAX}
                  step={HEADER_LOGO_WIDTH_STEP}
                  value={logoWidth}
                  onChange={(event) =>
                    onLogoChange({ ...logo, width: event.target.valueAsNumber })
                  }
                  className="h-11 w-full accent-foreground sm:h-4"
                  disabled={!logo.src}
                  aria-describedby="header-logo-width-description"
                />
                <p
                  id="header-logo-width-description"
                  className="text-[11px] leading-4 text-muted-foreground"
                >
                  Storefront display size. Mobile uses a safe cap.
                </p>
              </div>
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
                <div className="relative group border border-border rounded-md p-2 bg-muted/30 h-20 w-20 flex items-end justify-center gap-2 mx-auto">
                  {[16, 32].map((size) => (
                    <img
                      key={size}
                      src={getOptimizedImageUrl(
                        favicon.src,
                        ADMIN_IMAGE_PRESETS.favicon,
                      )}
                      alt={size === 32 ? favicon.alt || "Browser icon preview" : ""}
                      aria-hidden={size === 16 ? "true" : undefined}
                      style={{ width: size, height: size }}
                      className="object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                  ))}
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -right-2 -top-2 z-10 h-11 w-11 rounded-full opacity-100 shadow-md transition-opacity sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    onClick={removeFavicon}
                    title="Remove favicon"
                    aria-label="Remove browser icon"
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
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full sm:h-10"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    {favicon.src ? "Change icon" : "Choose icon"}
                  </Button>
                }
              />
              <div className="space-y-1.5">
                <Label htmlFor="header-favicon-alt" className="text-xs">
                  Description
                </Label>
                <Input
                  id="header-favicon-alt"
                  value={favicon.alt}
                  onChange={(e) =>
                    onFaviconChange({ ...favicon, alt: e.target.value })
                  }
                  placeholder="Describe the icon"
                  className="h-11 sm:h-9"
                  disabled={!favicon.src}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
