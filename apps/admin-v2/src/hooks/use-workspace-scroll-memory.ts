import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function getAdminScrollContainer(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("admin-main-scroll");
}

/**
 * Remembers the vertical position of URL-addressable tabs whose inactive
 * content is hidden in-place. Router restoration can run before that content
 * becomes measurable, so the active workspace reapplies its position after
 * the React commit.
 */
export function useWorkspaceScrollMemory(workspaceKey: string) {
  const positionsRef = useRef(new Map<string, number>());
  const activeKeyRef = useRef(workspaceKey);

  const rememberWorkspaceScroll = useCallback(() => {
    const container = getAdminScrollContainer();
    if (!container) return;
    positionsRef.current.set(activeKeyRef.current, container.scrollTop);
  }, []);

  useBrowserLayoutEffect(() => {
    if (activeKeyRef.current === workspaceKey) return;

    activeKeyRef.current = workspaceKey;
    const target = positionsRef.current.get(workspaceKey) ?? 0;
    const container = getAdminScrollContainer();
    if (!container) return;

    container.scrollTop = target;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTop = target;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [workspaceKey]);

  return rememberWorkspaceScroll;
}
