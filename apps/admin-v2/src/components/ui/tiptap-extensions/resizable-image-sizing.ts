const MINIMUM_IMAGE_WIDTH_PX = 80;
const MINIMUM_IMAGE_WIDTH_PERCENT = 20;

export function clampRichTextImageWidth(
  candidateWidth: number,
  editorWidth: number,
): number {
  const boundedEditorWidth = Math.max(1, editorWidth);
  const minimumWidth = Math.min(
    boundedEditorWidth,
    Math.max(
      MINIMUM_IMAGE_WIDTH_PX,
      boundedEditorWidth * (MINIMUM_IMAGE_WIDTH_PERCENT / 100),
    ),
  );
  return Math.min(
    boundedEditorWidth,
    Math.max(minimumWidth, candidateWidth),
  );
}

export function richTextImageWidthPercent(
  width: number,
  editorWidth: number,
): number {
  return Math.max(
    MINIMUM_IMAGE_WIDTH_PERCENT,
    Math.min(100, Math.round((width / Math.max(1, editorWidth)) * 100)),
  );
}

export function normalizeRichTextImageWidthPercent(
  value: string,
): number | null {
  if (value.trim() === "") return null;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) return null;
  return Math.min(
    100,
    Math.max(MINIMUM_IMAGE_WIDTH_PERCENT, Math.round(parsedValue)),
  );
}
