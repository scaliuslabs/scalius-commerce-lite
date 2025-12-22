import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./src/lib/sdk/openapi.json",
  output: "./src/lib/sdk/client",
  client: {
    bundle: true,
    name: "@hey-api/client-fetch",
  },
});
