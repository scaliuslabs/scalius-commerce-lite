export function shouldApplyExternalTiptapContent({
  incomingContent,
  lastExternalContent,
  editorContent,
}: {
  incomingContent: string;
  lastExternalContent: string;
  editorContent: string;
}): boolean {
  return (
    incomingContent !== lastExternalContent &&
    incomingContent !== editorContent
  );
}
