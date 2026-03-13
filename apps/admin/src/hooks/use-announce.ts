import { useCallback } from "react";

/**
 * Hook for announcing messages to screen readers
 * Uses ARIA live regions to announce dynamic content changes
 */
export function useAnnounce() {
  const announce = useCallback((message: string, priority: "polite" | "assertive" = "polite") => {
    // Check if announcement region exists, create if not
    let announcer = document.getElementById("aria-announcer");

    if (!announcer) {
      announcer = document.createElement("div");
      announcer.id = "aria-announcer";
      announcer.setAttribute("role", "status");
      announcer.setAttribute("aria-live", priority);
      announcer.setAttribute("aria-atomic", "true");
      announcer.className = "sr-only"; // Visually hidden but accessible to screen readers
      announcer.style.position = "absolute";
      announcer.style.left = "-10000px";
      announcer.style.width = "1px";
      announcer.style.height = "1px";
      announcer.style.overflow = "hidden";
      document.body.appendChild(announcer);
    }

    // Update the message
    announcer.textContent = message;

    // Clear after announcement
    setTimeout(() => {
      if (announcer) {
        announcer.textContent = "";
      }
    }, 1000);
  }, []);

  return announce;
}
