// What the plugin ABI seals hold (abi.snapshot.test.ts): the strict manifest
// JSON Schema, the protocol constants and the beta ports, built from the live
// modules. One builder, so the seal and the test that the emitted schemas do
// not depend on what ran first (abi-seals.test.ts) emit the same thing.
import { z } from "zod";
import { EVENTS_API_VERSION, EVENT_FACT_SCHEMAS, EVENT_TOPIC_RESOURCE } from "../events";
import { pluginManifestSchema, PLUGIN_API_VERSION } from "./manifest";
import { PLUGIN_EXTENSION_SCHEMAS, PLUGIN_FUNCTION_SCHEMAS } from "./functions";
import { PROVIDER_PORTS } from "./providers";
import { PROVIDER_OPERATIONS, PROVIDER_PORT_TIERS, type ProviderKind } from "./providers/kinds";
import { PLUGIN_SCOPES } from "./scopes";
import { APP_ERROR_CODES } from "./app-errors";
import * as protocol from "./storefront-protocol";
import { PLUGIN_UI_SURFACES, pluginUiDocumentSchema } from "./ui";

const schema = (value: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(value, { io });
const port = (value: { input: z.ZodType; output: z.ZodType }) => ({ input: schema(value.input), output: schema(value.output, "output") });

/** The ports of one tier with their operations' schemas. */
function portsOfTier(tier: "stable" | "beta") {
  return Object.fromEntries(Object.entries(PROVIDER_PORTS)
    .filter(([kind]) => PROVIDER_PORT_TIERS[kind as ProviderKind] === tier)
    .map(([name, operations]) => [name,
      Object.fromEntries(Object.entries(operations).map(([operation, value]) => [operation, port(value)])),
    ]));
}

/** The strict manifest JSON Schema. */
export function manifestSeal() {
  return { apiVersion: PLUGIN_API_VERSION, schema: schema(pluginManifestSchema) };
}

/** Functions, stable provider ports, UI, scopes, error codes, events and storefront protocol constants. */
export function protocolSeal() {
  return {
    apiVersion: PLUGIN_API_VERSION,
    functions: Object.fromEntries(Object.entries(PLUGIN_FUNCTION_SCHEMAS).map(([name, value]) => [name, port(value)])),
    extensions: port(PLUGIN_EXTENSION_SCHEMAS),
    providerTiers: PROVIDER_PORT_TIERS,
    providers: portsOfTier("stable"),
    // What an implementation of each stable port must have: it never changes.
    providerRequired: Object.fromEntries(Object.entries(PROVIDER_OPERATIONS)
      .filter(([kind]) => PROVIDER_PORT_TIERS[kind as ProviderKind] === "stable")
      .map(([kind, operations]) => [kind, operations.required])),
    ui: { document: schema(pluginUiDocumentSchema("admin")), surfaces: PLUGIN_UI_SURFACES }, scopes: PLUGIN_SCOPES,
    errors: APP_ERROR_CODES,
    events: { apiVersion: EVENTS_API_VERSION, resources: EVENT_TOPIC_RESOURCE,
      facts: Object.fromEntries(Object.entries(EVENT_FACT_SCHEMAS).map(([topic, value]) => [topic, schema(value, "output")])),
    },
    storefront: Object.fromEntries(Object.entries(protocol).filter(([name, value]) => name === name.toUpperCase() && typeof value !== "function")
      .map(([name, value]) => [name, value instanceof RegExp ? value.source : value])),
  };
}

/** The beta provider ports, outside the seal in a reviewed snapshot of their own. */
export function betaPortsSeal() {
  return { apiVersion: PLUGIN_API_VERSION, providers: portsOfTier("beta") };
}

/** Every zod schema the seals convert, for checks over the whole sealed graph. */
export function sealedSchemaRoots(): z.ZodType[] {
  const ports = Object.values(PROVIDER_PORTS).flatMap((operations) => Object.values(operations).flatMap((value) => [value.input, value.output]));
  return [
    pluginManifestSchema,
    ...Object.values(PLUGIN_FUNCTION_SCHEMAS).flatMap((value) => [value.input, value.output]),
    PLUGIN_EXTENSION_SCHEMAS.input, PLUGIN_EXTENSION_SCHEMAS.output,
    ...ports,
    ...(Object.keys(PLUGIN_UI_SURFACES) as Array<keyof typeof PLUGIN_UI_SURFACES>).map((surface) => pluginUiDocumentSchema(surface)),
    ...Object.values(EVENT_FACT_SCHEMAS),
  ] as z.ZodType[];
}
