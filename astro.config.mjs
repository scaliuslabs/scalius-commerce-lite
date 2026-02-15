// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import honoIntegration from "./src/integrations/hono-integration";
// Import Tailwind CSS Vite plugin directly
import tailwindcss from "@tailwindcss/vite";

// Use Cloudflare adapter for Cloudflare Workers deployment
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  // Disable dev toolbar to prevent errors
  devToolbar: { enabled: false },

  image: {
    // Allow images from R2 bucket domain
    domains: [
      process.env.CDN_DOMAIN_URL || "cdn.scalius.com",
      // Add R2 public URL domain (extract from env var)
      ...(process.env.R2_PUBLIC_URL ? [new URL(process.env.R2_PUBLIC_URL).hostname] : []),
    ],
    // Cache calculated dimensions to improve performance
    remotePatterns: [{ protocol: "https" }],
  },

  output: "server",

  // Add compression for better performance
  compressHTML: true,

  integrations: [
    react(),
    honoIntegration(),
  ],

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ["@libsql/client"],
    },
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
      external: ["node:buffer", "node:crypto", "node:util", "node:stream"],
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
      },
    },
  },

  adapter: cloudflare({
    // Enable platform proxy for local development (helps emulate CF bindings in `astro dev`)
    platformProxy: {
      enabled: true,
    },
    // Use Cloudflare's Image Resizing service for on-demand optimization
    imageService: "cloudflare",
  }),
});
