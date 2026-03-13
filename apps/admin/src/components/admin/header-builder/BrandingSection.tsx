// src/components/admin/header-builder/BrandingSection.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MediaManager } from "../MediaManager";
import { Trash2, AlertCircle } from "lucide-react";
import type { LogoConfig, FaviconConfig, MediaFile } from "./types";

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
    <div className="space-y-6">
      {/* Logo Section */}
      <Card className="border border-border shadow-sm">
        <CardHeader>
          <CardTitle>Site Logo</CardTitle>
          <CardDescription>
            Upload and manage your primary site logo displayed in the header.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
            <div className="md:col-span-1 flex flex-col items-center justify-center space-y-2">
              <Label className="text-sm font-medium mb-1">Logo Preview</Label>
              {logo.src ? (
                <div className="relative group border border-border rounded-lg p-3 bg-muted/30 w-full aspect-2/1 flex items-center justify-center">
                  <img
                    src={logo.src}
                    alt={logo.alt || "Logo preview"}
                    className="max-h-full max-w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-3 -right-3 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shadow-md rounded-full z-10"
                    onClick={removeLogo}
                    title="Remove logo"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-border rounded-lg p-3 bg-muted/30 w-full aspect-2/1 flex items-center justify-center text-xs text-muted-foreground font-medium">
                  No Logo Selected
                </div>
              )}
            </div>
            <div className="md:col-span-2 space-y-4">
              <MediaManager
                onSelect={handleLogoSelect}
                triggerLabel={logo.src ? "Change Logo" : "Select Logo Image"}
              />
              {!logo.src && (
                <Alert variant="destructive" className="mt-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Logo Required</AlertTitle>
                  <AlertDescription>
                    A site logo is essential for branding. Please upload one.
                  </AlertDescription>
                </Alert>
              )}
              <Input
                value={logo.alt}
                onChange={(e) => onLogoChange({ ...logo, alt: e.target.value })}
                placeholder="Describe your logo (for accessibility)"
                disabled={!logo.src}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Favicon Section */}
      <Card className="border border-border shadow-sm">
        <CardHeader>
          <CardTitle>Site Favicon</CardTitle>
          <CardDescription>
            Upload the favicon displayed in the browser tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
            <div className="md:col-span-1 flex flex-col items-center justify-center space-y-2">
              <Label className="text-sm font-medium mb-1">
                Favicon Preview
              </Label>
              {favicon.src ? (
                <div className="relative group border border-border rounded-lg p-3 bg-muted/30 w-full aspect-square flex items-center justify-center max-w-[120px] mx-auto">
                  <img
                    src={favicon.src}
                    alt={favicon.alt || "Favicon preview"}
                    className="h-10 w-10 object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                  <Button
                    variant="destructive"
                    size="icon"
                    className="absolute -top-3 -right-3 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shadow-md rounded-full z-10"
                    onClick={removeFavicon}
                    title="Remove favicon"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-border rounded-lg p-3 bg-muted/30 w-full aspect-square flex items-center justify-center text-xs text-muted-foreground font-medium max-w-[120px] mx-auto">
                  No Favicon
                </div>
              )}
            </div>
            <div className="md:col-span-2 space-y-4">
              <MediaManager
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
                placeholder="Describe your favicon"
                disabled={!favicon.src}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
