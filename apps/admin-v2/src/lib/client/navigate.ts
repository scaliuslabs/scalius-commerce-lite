/**
 * Imperative navigation helper.
 *
 * In TanStack Start, prefer `useNavigate()` from `@tanstack/react-router`
 * inside React components for SPA transitions. This helper exists for
 * non-component code (hooks, event handlers, utilities) that need to
 * navigate imperatively.
 *
 * Uses window.location for navigation which triggers a full page load.
 * For SPA-style navigation from within React components, use:
 *   const navigate = useNavigate()
 *   navigate({ to: '/admin/products' })
 */
export function navigateTo(url: string): void {
  if (typeof window === "undefined") return;
  window.location.href = url;
}
