import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
      <CardHeader>
        <CardTitle>Footer Content</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
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
            className="min-h-[150px]"
            compact={true}
          />
        </div>

        <div className="grid gap-2">
          <Label>Copyright Text</Label>
          <Input
            value={copyrightText}
            onChange={(e) => onCopyrightChange(e.target.value)}
            placeholder="© 2024 Your Company. All rights reserved."
          />
        </div>
      </CardContent>
    </Card>
  );
}
