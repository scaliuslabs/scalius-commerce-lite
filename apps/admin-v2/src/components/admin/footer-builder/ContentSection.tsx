import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { DeferredTiptapEditor } from "@/components/ui/tiptap/DeferredTiptapEditor";

interface ContentSectionProps {
  tagline: string;
  description: string;
  copyrightText: string;
  onTaglineChange: (tagline: string) => void;
  onDescriptionChange: (description: string) => void;
  onCopyrightChange: (copyrightText: string) => void;
}

export function ContentSection({
  tagline,
  description,
  copyrightText,
  onTaglineChange,
  onDescriptionChange,
  onCopyrightChange,
}: ContentSectionProps) {
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle>Footer Content</CardTitle>
        <CardDescription>
          Keep this short so help links remain easy to scan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        <div className="grid gap-2">
          <Label>Tagline</Label>
          <Input
            value={tagline}
            onChange={(e) => onTaglineChange(e.target.value)}
            placeholder="A short tagline for your brand"
          />
        </div>

        <div className="grid gap-2">
          <Label>Description</Label>
          <DeferredTiptapEditor
            content={description}
            onChange={onDescriptionChange}
            placeholder="Enter footer description..."
            ariaLabel="Footer description"
            className="min-h-[150px]"
            compact={true}
          />
        </div>

        <div className="grid gap-2">
          <Label>Copyright owner</Label>
          <Input
            value={copyrightText}
            onChange={(e) => onCopyrightChange(e.target.value)}
            placeholder="Your business or store name"
          />
          <p className="text-xs text-muted-foreground">
            The storefront adds the current year and “All rights reserved.”
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
