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
    },
    {
      name: "@hey-api/client-fetch",
      bundle: true,
    },
  ],
});
