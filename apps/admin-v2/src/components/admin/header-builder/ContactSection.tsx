// src/components/admin/header-builder/ContactSection.tsx
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
import type { ContactConfig } from "./types";

interface ContactSectionProps {
  contact: ContactConfig;
  onChange: (contact: ContactConfig) => void;
}

export function ContactSection({ contact, onChange }: ContactSectionProps) {
  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Header contact</CardTitle>
            <CardDescription>
              Give customers a direct support number.
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
      <CardContent className="grid max-w-3xl grid-cols-1 gap-3 px-4 pb-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="contact-phone">Phone number</Label>
          <Input
            id="contact-phone"
            value={contact.phone}
            onChange={(e) => onChange({ ...contact, phone: e.target.value })}
            placeholder="e.g. +880 1712 345678"
            className="h-11 sm:h-9"
            type="tel"
            disabled={!contact.isEnabled}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact-text">Supporting text</Label>
          <Input
            id="contact-text"
            value={contact.text}
            onChange={(e) => onChange({ ...contact, text: e.target.value })}
            placeholder="e.g. Every day, 9am–9pm"
            className="h-11 sm:h-9"
            disabled={!contact.isEnabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
