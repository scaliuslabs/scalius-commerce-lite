function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:html|css)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? content;
}

function stripTagWrapper(content: string, tagName: string): string {
  const fullTagPattern = new RegExp(
    String.raw`^\s*<${tagName}\b[^>]*>([\s\S]*?)</${tagName}>\s*$`,
    "i",
  );
  const fullMatch = content.match(fullTagPattern);
  if (fullMatch?.[1] !== undefined) {
    return fullMatch[1].trim();
  }

  return content
    .replace(new RegExp(String.raw`^\s*<${tagName}\b[^>]*>\s*`, "i"), "")
    .replace(new RegExp(String.raw`\s*</${tagName}>\s*$`, "i"), "")
    .trim();
}

function repairGeneratedCssComments(css: string): string {
  return css
    .replace(/\/\*\s*([^*\n]*?)\s\/\s*(?=\r?\n)/g, "/* $1 */")
    .replace(/;\s\/\s([^*{}\n][^*{}]*?)\s\*\//g, "; /* $1 */");
}

export function normalizeWidgetHtml(html: string): string {
  let normalized = stripCodeFence(html);
  normalized = stripTagWrapper(normalized, "htmljs");
  normalized = stripTagWrapper(normalized, "html");
  return normalized;
}

export function normalizeWidgetCss(css: string | null | undefined): string {
  if (!css) return "";

  let normalized = stripCodeFence(css);
  normalized = stripTagWrapper(normalized, "css");
  return repairGeneratedCssComments(normalized);
}
