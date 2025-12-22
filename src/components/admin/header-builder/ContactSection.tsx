// src/components/admin/header-builder/ContactSection.tsx
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
import type { ContactConfig } from "./types";

interface ContactSectionProps {
  contact: ContactConfig;
  onChange: (contact: ContactConfig) => void;
}

export function ContactSection({ contact, onChange }: ContactSectionProps) {
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Contact Information</CardTitle>
            <CardDescription>
              Display contact details in the header area.
            </CardDescription>
          </div>
          <div className="flex items-center space-x-2">
            <Label htmlFor="contact-enabled" className="text-sm font-medium">
              {contact.isEnabled ? "Visible" : "Hidden"}
            </Label>
            <Switch
              id="contact-enabled"
              checked={contact.isEnabled}
              onCheckedChange={(checked) =>
                onChange({ ...contact, isEnabled: checked })
              }
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl">
        <div className="space-y-2">
          <Label htmlFor="contact-phone">Contact Phone Number</Label>
          <Input
            id="contact-phone"
            value={contact.phone}
            onChange={(e) => onChange({ ...contact, phone: e.target.value })}
            placeholder="e.g., +1 (555) 123-4567"
            type="tel"
            disabled={!contact.isEnabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact-text">Supporting Text</Label>
          <Input
            id="contact-text"
            value={contact.text}
            onChange={(e) => onChange({ ...contact, text: e.target.value })}
            placeholder="e.g., Call us Mon-Fri 9am-5pm"
            disabled={!contact.isEnabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
