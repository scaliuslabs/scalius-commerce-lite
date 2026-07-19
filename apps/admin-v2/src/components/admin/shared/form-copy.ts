export function getFormEntityLabel(title: string, newLabel?: string): string {
  const candidate = (newLabel?.trim() || title.trim())
    .replace(/^(?:new|create|edit)\s+/i, "")
    .trim();

  return candidate.replace(/s$/i, "");
}
