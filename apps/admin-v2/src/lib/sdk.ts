// Thin wrapper over @scalius/api-client configured for admin use.
// The admin communicates with the API via service binding (env.API).
// In development, requests go through the Vite proxy at /api/v1.
export { client } from "@scalius/api-client";
export type { CreateClientConfig } from "@scalius/api-client";
