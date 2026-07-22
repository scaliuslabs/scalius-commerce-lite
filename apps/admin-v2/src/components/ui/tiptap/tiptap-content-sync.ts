export interface TiptapContentReconciliation {
  shouldApply: boolean;
  pendingLocalContents: string[];
}

export function reconcileExternalTiptapContent({
  incomingContent,
  lastExternalContent,
  editorContent,
  pendingLocalContents,
}: {
  incomingContent: string;
  lastExternalContent: string;
  editorContent: string;
  pendingLocalContents: readonly string[];
}): TiptapContentReconciliation {
  const acknowledgedLocalIndex = pendingLocalContents.indexOf(incomingContent);
  if (acknowledgedLocalIndex >= 0) {
    return {
      shouldApply: false,
      pendingLocalContents: pendingLocalContents.slice(
        acknowledgedLocalIndex + 1,
      ),
    };
  }

  const shouldApply =
    incomingContent !== lastExternalContent &&
    incomingContent !== editorContent;

  return {
    shouldApply,
    pendingLocalContents: shouldApply ? [] : [...pendingLocalContents],
  };
}
