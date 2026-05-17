
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { normalizeGeneratedWidgetContent, parseGeneratedWidgetContent } from './widget-generation-content';

interface WidgetPasteModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onApply: (content: { html: string; css: string; js?: string }) => void;
}

export const WidgetPasteModal: React.FC<WidgetPasteModalProps> = ({ isOpen, onOpenChange, onApply }) => {
  const [jsonInput, setJsonInput] = useState("");

  const handleApply = () => {
    if (!jsonInput.trim()) {
      toast.error("Please paste some content first.");
      return;
    }

    try {
      onApply(normalizeGeneratedWidgetContent(parseGeneratedWidgetContent(jsonInput)));
      toast.success("Widget content applied successfully!");
      onOpenChange(false);
      setJsonInput("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid widget content.");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Paste AI Response</DialogTitle>
          <DialogDescription>
            Paste the response from an external AI chatbot below. Accepts tag-based format (&lt;htmljs&gt;/&lt;css&gt;/&lt;js&gt;) and JSON format.
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

<js>
  widget.query("button")?.addEventListener("click", () => { ... })
</js>

Or JSON format:
{
  "html": "<div>...</div>",
  "css": ".my-class { ... }",
  "js": "..."
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
