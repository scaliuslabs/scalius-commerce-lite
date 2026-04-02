// ESM re-export of the bundled @hey-api/client-fetch CJS module.
// The code generator only emits .cjs — this wrapper lets Vite's ESM
// module runner (used by Astro's Cloudflare adapter) resolve the import.
export { createClient, createConfig, formDataBodySerializer, jsonBodySerializer, urlSearchParamsBodySerializer } from "./index.cjs";
