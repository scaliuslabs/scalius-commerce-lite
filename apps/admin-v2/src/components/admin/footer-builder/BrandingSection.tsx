// src/components/admin/footer-builder/BrandingSection.tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { MediaManager } from "../media-manager";
import { Trash2 } from "lucide-react";
import type { LogoConfig, MediaFile } from "./types";

interface BrandingSectionProps {
  logo: LogoConfig;
  onLogoChange: (logo: LogoConfig) => void;
}

export function BrandingSection({ logo, onLogoChange }: BrandingSectionProps) {
  const handleLogoSelect = (file: MediaFile) => {
    onLogoChange({ src: file.url, alt: file.filename || "Footer Logo" });
  };

  const removeLogo = () => {
    onLogoChange({ src: "", alt: "" });
  };

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-base">Footer logo</CardTitle>
        <CardDescription>
          Reuse the header logo or choose one for the footer background.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
          <div>
            {logo.src ? (
              <div className="relative group border rounded-md p-2 bg-muted/30 aspect-2/1 flex items-center justify-center">
                <img
                  src={logo.src}
                  alt={logo.alt}
                  className="max-h-full max-w-full object-contain"
                />
                <Button
                  size="icon"
                  variant="destructive"
                  className="absolute -top-2 -right-2 h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  onClick={removeLogo}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="border border-dashed rounded-md p-2 bg-muted/30 aspect-2/1 flex items-center justify-center text-muted-foreground text-xs">
                No logo
              </div>
            )}
          </div>
          <div className="space-y-3">
            <MediaManager
              capability="image"
              onSelect={handleLogoSelect}
              triggerLabel={logo.src ? "Change Logo" : "Select Logo"}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
