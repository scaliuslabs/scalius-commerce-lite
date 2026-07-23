export function shouldExitRichTextFullscreen(
  event: Pick<KeyboardEvent, "key" | "target">,
  editorRoot: HTMLElement | null,
): boolean {
  if (event.key !== "Escape" || !editorRoot) {
    return false;
  }

  return event.target instanceof Node && editorRoot.contains(event.target);
}

interface IsolatedElementState {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

/**
 * Keep the fullscreen editor as the only interactive branch of the existing
 * page without moving it into a portal. Popovers opened after isolation can
 * still portal to the document body, while the admin shell behind the editor
 * is removed from focus and the accessibility tree.
 */
export function isolateRichTextFullscreenBackground(
  editorRoot: HTMLElement,
): () => void {
  const isolated: IsolatedElementState[] = [];
  let activeBranch: HTMLElement | null = editorRoot;

  while (activeBranch?.parentElement) {
    const parentElement: HTMLElement = activeBranch.parentElement;

    for (const sibling of parentElement.children) {
      if (sibling === activeBranch || !(sibling instanceof HTMLElement)) {
        continue;
      }

      isolated.push({
        element: sibling,
        inert: sibling.inert,
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }

    if (parentElement === document.body) break;
    activeBranch = parentElement;
  }

  return () => {
    for (const state of isolated) {
      state.element.inert = state.inert;
      if (state.ariaHidden === null) {
        state.element.removeAttribute("aria-hidden");
      } else {
        state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
    }
  };
}
