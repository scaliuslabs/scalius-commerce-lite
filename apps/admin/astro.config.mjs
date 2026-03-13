// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
// Import Tailwind CSS Vite plugin directly
import tailwindcss from "@tailwindcss/vite";

// Use Cloudflare adapter for Cloudflare Workers deployment
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  experimental: {
    rustCompiler: true,
  },
  // Disable dev toolbar to prevent errors
  devToolbar: { enabled: false },

  security: {
    checkOrigin: false,
  },

  image: {
    // Allow images from R2 bucket domain
    domains: [
      ...(process.env.CDN_DOMAIN_URL ? [process.env.CDN_DOMAIN_URL] : []),
      // Add R2 public URL domain (extract from env var)
      ...(process.env.R2_PUBLIC_URL ? [new URL(process.env.R2_PUBLIC_URL).hostname] : []),
    ],
    // Cache calculated dimensions to improve performance
    remotePatterns: [{ protocol: "https" }],
  },

  output: "server",

  // Add compression for better performance
  compressHTML: true,

  // Targeted prefetching avoids network saturation on link-heavy tables
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "hover",
  },

  integrations: [
    react(),
  ],

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {},
    define: {
      global: "globalThis",
    },
    resolve: {
      // Use react-dom/server.edge for production builds (Cloudflare Workers)
      // This prevents MessageChannel errors in edge environments
      alias:
        process.env.NODE_ENV === "production"
          ? {
            "react-dom/server": "react-dom/server.edge",
          }
          : undefined,
    },
    ssr: {
      // Prevent specific packages from being externalized during SSR build
      noExternal: [
        // Radix UI specific components (list common ones)
        "@radix-ui/react-slot",
        "@radix-ui/react-compose-refs",
        "@radix-ui/react-primitive",
        "@radix-ui/react-alert-dialog",
        "@radix-ui/react-checkbox",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-label",
        "@radix-ui/react-navigation-menu",
        "@radix-ui/react-popover",
        "@radix-ui/react-progress",
        "@radix-ui/react-radio-group",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-switch",
        "@radix-ui/react-tabs",
        "@radix-ui/react-toast",
        "@radix-ui/react-tooltip",
        // Radix UI wildcard (fallback)
        /^@radix-ui\/.*/,
        // Lucide icons
        "lucide-react",
      ],
      // Enable Node.js compatibility for Cloudflare Workers
      external: [
        "node:buffer",
        "node:crypto",
        "node:util",
        "node:stream",
        "node:fs/promises",
        "node:path",
        "node:url",
        "node:async_hooks"
      ],
      resolve: {
        // Prioritize 'workerd' and 'node' conditions over 'browser'
        // This prevents Vite from picking up the browser-specific build of react-dom/server
        conditions: ["workerd", "node", "worker"],
      },
    },
    build: {
      // Improve build performance
      cssCodeSplit: true,
      // Enable minification for production (smaller bundles, faster load)
      // Disable only in dev for easier debugging
      minify: process.env.NODE_ENV !== "development",
    },
    // Add caching for better dev performance
    server: {
      hmr: {
        overlay: true,
        port: 24678,
      },
      // Proxy /api/v1/* to the standalone API worker in dev.
      // Vite intercepts before workerd, so multipart bodies stream correctly.
      // In production, apps/admin/src/pages/api/v1/[...path].ts handles this via service binding.
      proxy: {
        "/api/v1": {
          target: "http://localhost:8787",
          changeOrigin: true,
        },
      },
    },
  },

  adapter: cloudflare({
    // Use passthrough — we handle all image optimization ourselves via
    // getOptimizedImageUrl() which routes transforms through the CDN origin.
    // This avoids depending on Image Resizing being enabled on the app zone.
    imageService: "passthrough",
    // Share D1/KV/R2 state with API worker (both persist to root .wrangler/state/)
    persistState: { path: "../../.wrangler/state" },
  }),
});
