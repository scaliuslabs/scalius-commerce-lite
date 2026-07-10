import { useEffect, useId, useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

import { MediaApiClient } from "../api/mediaClient";
import type { GeneratedImagePreview, MediaFile } from "../types";

interface GeneratedImagePanelProps {
  folderId?: string | null;
  onSaved: (file: MediaFile) => void | Promise<void>;
  saveActionLabel?: string;
}

const ASPECT_RATIOS = [
  { value: "auto", label: "Provider default" },
  { value: "1:1", label: "Square (1:1)" },
  { value: "4:5", label: "Portrait (4:5)" },
  { value: "3:2", label: "Landscape (3:2)" },
  { value: "16:9", label: "Wide (16:9)" },
] as const;

type AspectRatio = (typeof ASPECT_RATIOS)[number]["value"];

export function GeneratedImagePanel({
  folderId,
  onSaved,
  saveActionLabel = "Save to media library",
}: GeneratedImagePanelProps) {
  const promptId = useId();
  const altTextId = useId();
  const aspectRatioId = useId();
  const abortRef = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [altText, setAltText] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("auto");
  const [preview, setPreview] = useState<GeneratedImagePreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!preview) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(preview.blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const discardPreview = () => {
    setPreview(null);
    setError(null);
  };

  const generate = async () => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setError(null);
    setPreview(null);
    try {
      const generated = await MediaApiClient.generateImagePreview({
        prompt: normalizedPrompt,
        aspectRatio,
        signal: controller.signal,
      });
      setPreview(generated);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Image generation failed. Please try again.",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsGenerating(false);
    }
  };

  const save = async () => {
    if (!preview) return;
    if (preview.expiresAt.getTime() <= Date.now()) {
      setError("This preview expired. Generate it again before saving.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const saved = await MediaApiClient.saveGeneratedImage({
        preview,
        altText,
        folderId,
      });
      await onSaved(saved);
      toast.success("Generated image saved", {
        description: "The verified image is now in your media library.",
      });
      setPreview(null);
      setPrompt("");
      setAltText("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Saving the generated image failed. Please try again.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section
      className="border-b bg-muted/10 px-4 py-2"
      aria-labelledby={`${promptId}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`${promptId}-title`} className="text-sm font-medium">
            Generate product imagery
          </h3>
          <p className="text-xs text-muted-foreground">
            Uses the saved Image generation provider and model. Nothing enters
            the library until you save the preview; the merchant must click to
            confirm both provider generation and library save.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={`${promptId}-panel`}
          data-scalius-computer-action="allow"
          onClick={() => setOpen((current) => !current)}
        >
          <Sparkles className="mr-2 h-4 w-4" />
          {open ? "Close generator" : "Generate with AI"}
        </Button>
      </div>

      {open && (
        <div id={`${promptId}-panel`} className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={promptId}>Image prompt</Label>
              <Textarea
                id={promptId}
                value={prompt}
                maxLength={4_000}
                rows={4}
                placeholder="A premium studio product photograph on a clean background..."
                data-scalius-computer-action="allow"
                onChange={(event) => setPrompt(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {prompt.length.toLocaleString()} / 4,000 characters
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={aspectRatioId}>Aspect ratio</Label>
                <select
                  id={aspectRatioId}
                  value={aspectRatio}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  data-scalius-computer-action="allow"
                  onChange={(event) =>
                    setAspectRatio(event.target.value as AspectRatio)
                  }
                >
                  {ASPECT_RATIOS.map((ratio) => (
                    <option key={ratio.value} value={ratio.value}>
                      {ratio.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={altTextId}>Alt text for saved image</Label>
                <Input
                  id={altTextId}
                  value={altText}
                  maxLength={500}
                  placeholder="Describe the product image"
                  data-scalius-computer-action="allow"
                  onChange={(event) => setAltText(event.target.value)}
                />
              </div>
            </div>

            <Button
              type="button"
              disabled={!prompt.trim() || isGenerating || isSaving}
              data-scalius-computer-human-only
              onClick={generate}
            >
              {isGenerating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="mr-2 h-4 w-4" />
              )}
              {isGenerating ? "Generating one preview..." : "Generate image"}
            </Button>
          </div>

          <div className="min-h-48 rounded-lg border bg-background p-3">
            {preview && previewUrl ? (
              <div className="space-y-3">
                <img
                  src={previewUrl}
                  alt={altText.trim() || "Generated image preview"}
                  className="mx-auto max-h-72 w-full rounded-md object-contain"
                />
                <dl className="grid gap-1 text-xs text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Provider</dt>
                    <dd>{preview.provider}</dd>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <dt className="shrink-0 font-medium text-foreground">Model</dt>
                    <dd className="break-all">{preview.model}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Usage</dt>
                    <dd>{usageLabel(preview)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Cost</dt>
                    <dd>{costLabel(preview)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Preview expires</dt>
                    <dd>{preview.expiresAt.toLocaleTimeString()}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={isSaving}
                    data-scalius-computer-human-only
                    onClick={save}
                  >
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {isSaving ? "Saving verified image..." : saveActionLabel}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={isSaving}
                    data-scalius-computer-action="allow"
                    onClick={discardPreview}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Discard preview
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-44 items-center justify-center text-center text-sm text-muted-foreground">
                {isGenerating
                  ? "The saved model is generating one bounded preview."
                  : "Your generated preview and its provider, model, usage, and cost facts will appear here."}
              </div>
            )}
            {error && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function usageLabel(preview: GeneratedImagePreview): string {
  const { inputTokens, outputTokens, totalTokens } = preview.usage;
  if (totalTokens !== undefined) return `${totalTokens.toLocaleString()} total tokens`;
  const parts = [
    inputTokens !== undefined ? `${inputTokens.toLocaleString()} input` : null,
    outputTokens !== undefined ? `${outputTokens.toLocaleString()} output` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(", ")} tokens` : "Not reported by provider";
}

function costLabel(preview: GeneratedImagePreview): string {
  if (
    preview.cost.status === "reported" &&
    preview.cost.usdMicros !== undefined
  ) {
    return `$${(preview.cost.usdMicros / 1_000_000).toFixed(6)} USD`;
  }
  return "Not reported by provider; check provider billing";
}
