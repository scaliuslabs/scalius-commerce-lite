// Re-export generated SDK types and client
export * from "./generated/types.gen";
export * from "./generated/sdk.gen";
export { client } from "./generated/client.gen";
export type { CreateClientConfig } from "./generated/client.gen";

// Re-export client factory
export {
  createServiceBindingClient,
  createHttpClient,
  createClient,
  createConfig,
} from "./client-factory";
export type { ServiceBindingOptions, HttpOptions } from "./client-factory";
