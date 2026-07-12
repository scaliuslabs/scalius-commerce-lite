// src/components/admin/header-builder/TopBarSection.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import type { TopBarConfig } from "./types";

interface TopBarSectionProps {
  topBar: TopBarConfig;
  onChange: (topBar: TopBarConfig) => void;
}

export function TopBarSection({ topBar, onChange }: TopBarSectionProps) {
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Announcement bar</CardTitle>
            <CardDescription>
              One short message above the storefront header.
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
      <CardContent className="space-y-2 px-4 pb-4">
        <Label htmlFor="announcement-text">Message</Label>
        <Input
          id="announcement-text"
          value={topBar.text}
          onChange={(e) => onChange({ ...topBar, text: e.target.value })}
          placeholder="Free delivery in Dhaka on orders over ৳2,000"
          className="max-w-2xl h-9"
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
