// src/components/admin/header-builder/TopBarSection.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { TopBarConfig } from "./types";

interface TopBarSectionProps {
  topBar: TopBarConfig;
  onChange: (topBar: TopBarConfig) => void;
}

export function TopBarSection({ topBar, onChange }: TopBarSectionProps) {
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Announcement Bar</CardTitle>
            <CardDescription>
              Display a promotional message or announcement at the very top of
              your site.
            </CardDescription>
          </div>
          <div className="flex items-center space-x-2">
            <Label htmlFor="topbar-enabled" className="text-sm font-medium">
              {topBar.isEnabled ? "Enabled" : "Disabled"}
            </Label>
            <Switch
              id="topbar-enabled"
              checked={topBar.isEnabled}
              onCheckedChange={(checked) =>
                onChange({ ...topBar, isEnabled: checked })
              }
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="announcement-text">Announcement Text</Label>
        <Input
          id="announcement-text"
          value={topBar.text}
          onChange={(e) => onChange({ ...topBar, text: e.target.value })}
          placeholder="E.g., Free shipping on orders over $50!"
          className="max-w-2xl"
          disabled={!topBar.isEnabled}
        />
        {!topBar.isEnabled && topBar.text && (
          <p className="text-sm text-muted-foreground">
            The announcement bar is currently disabled. Enable it to show on
            your storefront.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
