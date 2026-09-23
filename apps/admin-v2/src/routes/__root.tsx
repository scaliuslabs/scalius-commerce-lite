import { Outlet, createRootRouteWithContext, HeadContent } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

interface RouterContext {
  queryClient: QueryClient;
}

// The document shell (charset, viewport, favicon, theme, stylesheet) is the
// static index.html; routes only contribute their <title> and meta tags.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return (
    <>
      <HeadContent />
      <Outlet />
    </>
  );
}
