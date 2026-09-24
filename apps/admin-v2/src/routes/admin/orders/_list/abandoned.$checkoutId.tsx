import { createFileRoute } from "@tanstack/react-router";

/**
 * An abandoned checkout opened from the list. The list (parent route) keeps
 * its sheet mounted and opens it while this route matches, so the URL, back
 * button and Cmd-click work like any row link.
 */
export const Route = createFileRoute("/admin/orders/_list/abandoned/$checkoutId")({
  component: () => null,
});
