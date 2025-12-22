
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { parseTagBasedResponse, validateParsedWidget } from '@/lib/tag-parser';
import { parseJSONSafely, validateWidgetJSON } from '@/lib/json-repair';

interface WidgetPasteModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onApply: (content: { html: string; css: string; }) => void;
}

export const WidgetPasteModal: React.FC<WidgetPasteModalProps> = ({ isOpen, onOpenChange, onApply }) => {
  const [jsonInput, setJsonInput] = useState("");

  const handleApply = () => {
    if (!jsonInput.trim()) {
      toast.error("Please paste some content first.");
      return;
    }

    // Try tag-based format first (this is what Copy Prompt generates)
    const tagResult = parseTagBasedResponse(jsonInput);

    if (tagResult.success && tagResult.data) {
      const validation = validateParsedWidget(tagResult.data);
      if (validation.valid) {
        onApply({ html: tagResult.data.html, css: tagResult.data.css || '' });
        toast.success("Tag-based content applied successfully!");
        onOpenChange(false);
        setJsonInput("");
        return;
      }
    }

    // Fallback to JSON format
    const jsonResult = parseJSONSafely(jsonInput);

    if (jsonResult.success && jsonResult.data) {
      const validation = validateWidgetJSON(jsonResult.data);
      if (validation.valid) {
        onApply({ html: jsonResult.data.html, css: jsonResult.data.css || '' });
        toast.success("JSON content applied successfully!");
        onOpenChange(false);
        setJsonInput("");
        return;
      } else {
        toast.error(`Invalid JSON structure: ${validation.error}`);
        return;
      }
    }

    // Both parsing methods failed
    toast.error("Invalid format. Please paste either tag-based format (<htmljs>/<css>) or valid JSON.");
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Paste AI Response</DialogTitle>
          <DialogDescription>
            Paste the response from an external AI chatbot below. Accepts both tag-based format (&lt;htmljs&gt;/&lt;css&gt;) and JSON format.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <Textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            placeholder='Tag-based format (recommended):
<htmljs>
  <div>...</div>
</htmljs>

<css>
  .my-class { ... }
</css>

Or JSON format:
{
  "html": "<div>...</div>",
  "css": ".my-class { ... }"
}'
            rows={15}
          />
        </div>
        <DialogFooter>
          <Button type="button" onClick={handleApply}>Apply Content</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
