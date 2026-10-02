import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi.json",
  output: "./src/generated",
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: true,
    },
    {
      name: "@hey-api/sdk",
      exportFromIndex: true,
      // Clients authenticate themselves (the dashboard's session cookie, the
      // storefront's transport, a caller's headers), never through per-call
      // `security` schemes: leaving those out keeps every bundle's SDK small.
      auth: false,
      operations: {
        nesting: "id",
      },
    },
    {
      name: "@hey-api/client-fetch",
      bundle: true,
    },
  ],
});
