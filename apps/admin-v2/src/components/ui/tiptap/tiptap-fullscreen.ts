export function shouldExitRichTextFullscreen(
  event: Pick<KeyboardEvent, "key" | "target">,
  editorRoot: HTMLElement | null,
): boolean {
  if (event.key !== "Escape" || !editorRoot) {
    return false;
  }

  return event.target instanceof Node && editorRoot.contains(event.target);
}
