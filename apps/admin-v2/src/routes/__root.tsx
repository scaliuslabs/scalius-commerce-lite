/// <reference types="vite/client" />
import type { ReactNode } from "react";
import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import appCss from "~/styles/global.css?url";
import { themeInitScript } from "~/components/admin/layout/ThemeProvider";
import {
  DASHBOARD_BASE_PATH_META_NAME,
  getDashboardBasePath,
  prefixDashboardBasePath,
} from "~/lib/dashboard-base-path";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => {
    // The runtime base path is published to the browser before any script
    // runs; direct asset imports are prefixed here because the Start manifest
    // transform only covers manifest-managed assets.
    const basePath = getDashboardBasePath();
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "Scalius Admin" },
        { name: DASHBOARD_BASE_PATH_META_NAME, content: basePath },
      ],
      links: [
        { rel: "stylesheet", href: prefixDashboardBasePath(basePath, appCss) },
        { rel: "icon", href: prefixDashboardBasePath(basePath, "/favicon.png") },
      ],
      scripts: [
        {
          children: themeInitScript,
        },
      ],
    };
  },
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
