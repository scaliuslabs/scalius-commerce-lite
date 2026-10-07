// Provider ports (docs/platform/PLUGINS.md, "Providers"): one typed port per
// kind that both the platform's own adapters and app providers implement.
// The pieces live in ./providers/*; this barrel is the one import path
// (`@scalius/shared/plugins/providers`). Code that must stay free of zod
// (the SDK root, the sandbox wrapper) imports `./providers/kinds` alone.

import type { z } from "zod";
import { COURIER_PORT } from "./providers/courier";
import { providerConnectionSchema, providerNoInputSchema } from "./providers/common";
import { EMAIL_PORT, SMS_PORT } from "./providers/messaging";
import { FRAUD_PORT } from "./providers/fraud";
import { PROVIDER_OPERATIONS, type ProviderKind } from "./providers/kinds";
import { PAYMENT_PORT } from "./providers/payment";
import { TAX_PORT } from "./providers/tax";
import { TRANSLATION_PORT } from "./providers/translation";

export * from "./providers/kinds";
export * from "./providers/common";
export * from "./providers/amount";
export * from "./providers/payment";
export * from "./providers/courier";
export * from "./providers/messaging";
export * from "./providers/fraud";
export * from "./providers/tax";
export * from "./providers/translation";
export * from "./providers/descriptors";

/** Every port answers whether its saved credentials authenticate. */
const TEST_CONNECTION = { input: providerNoInputSchema, output: providerConnectionSchema } as const;

/** Input and output schemas of every operation of every port: the host validates both sides of each call. */
export const PROVIDER_PORTS = {
  payment: { ...PAYMENT_PORT, testConnection: TEST_CONNECTION },
  courier: { ...COURIER_PORT, testConnection: TEST_CONNECTION },
  sms: { ...SMS_PORT, testConnection: TEST_CONNECTION },
  email: { ...EMAIL_PORT, testConnection: TEST_CONNECTION },
  fraud: { ...FRAUD_PORT, testConnection: TEST_CONNECTION },
  tax: { ...TAX_PORT, testConnection: TEST_CONNECTION },
  translation: { ...TRANSLATION_PORT, testConnection: TEST_CONNECTION },
} as const;

type Ports = typeof PROVIDER_PORTS;
type RequiredOperation<K extends ProviderKind> = (typeof PROVIDER_OPERATIONS)[K]["required"][number] & keyof Ports[K];
type OptionalOperation<K extends ProviderKind> = (typeof PROVIDER_OPERATIONS)[K]["optional"][number] & keyof Ports[K];
type Schemas<K extends ProviderKind, M extends keyof Ports[K]> = Ports[K][M] extends { input: z.ZodType; output: z.ZodType } ? Ports[K][M] : never;

export type ProviderOperation<K extends ProviderKind> = keyof Ports[K] & string;
export type ProviderOperationInput<K extends ProviderKind, M extends keyof Ports[K]> = z.output<Schemas<K, M>["input"]>;
export type ProviderOperationOutput<K extends ProviderKind, M extends keyof Ports[K]> = z.output<Schemas<K, M>["output"]>;

/**
 * One operation. Declared in method form (the `method` key) so a port over a
 * narrower context (a gateway's own settings type) still fits where the
 * general port is expected, as interface methods do.
 */
type Operation<K extends ProviderKind, M extends keyof Ports[K], C, R> = {
  method(input: ProviderOperationInput<K, M>, context: C): R extends "sync-or-async"
    ? ProviderOperationOutput<K, M> | Promise<ProviderOperationOutput<K, M>>
    : Promise<ProviderOperationOutput<K, M>>;
}["method"];

/**
 * A port as the platform calls it: every required operation, the optional
 * ones it has. `C` is what a call gets besides its input (a built-in
 * adapter's saved settings; an app's `ctx`).
 */
export type ProviderPort<K extends ProviderKind, C> =
  { [M in RequiredOperation<K>]: Operation<K, M, C, "async"> }
  & { [M in OptionalOperation<K>]?: Operation<K, M, C, "async"> };

/** A port as an implementation writes it: operations may answer synchronously. */
export type ProviderImplementation<K extends ProviderKind, C> =
  { [M in RequiredOperation<K>]: Operation<K, M, C, "sync-or-async"> }
  & { [M in OptionalOperation<K>]?: Operation<K, M, C, "sync-or-async"> };

/** The schemas of one operation, or null when the port has no such operation. */
export function providerOperationSchemas(kind: ProviderKind, operation: string): { input: z.ZodType; output: z.ZodType } | null {
  const port = PROVIDER_PORTS[kind] as Record<string, { input: z.ZodType; output: z.ZodType }>;
  return Object.hasOwn(port, operation) ? port[operation]! : null;
}
