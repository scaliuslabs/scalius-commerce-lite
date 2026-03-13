// src/components/admin/footer-builder/BrandingSection.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MediaManager } from "../MediaManager";
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
      <CardHeader>
        <CardTitle>Footer Logo</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            {logo.src ? (
              <div className="relative group border rounded-lg p-4 bg-muted/30 aspect-2/1 flex items-center justify-center">
                <img
                  src={logo.src}
                  alt={logo.alt}
                  className="max-h-full max-w-full object-contain"
                />
                <Button
                  size="icon"
                  variant="destructive"
                  className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={removeLogo}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="border-2 border-dashed rounded-lg p-4 bg-muted/30 aspect-2/1 flex items-center justify-center text-muted-foreground text-sm">
                No Logo
              </div>
            )}
          </div>
          <div className="md:col-span-2 space-y-4">
            <MediaManager
              onSelect={handleLogoSelect}
              triggerLabel={logo.src ? "Change Logo" : "Select Logo"}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
