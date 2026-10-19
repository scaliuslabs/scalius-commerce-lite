/**
 * Tests only: validates documents against the vendored, published UCP
 * 2026-08-25 JSON Schemas (schemas/2026-08-25, provenance in SOURCE.json).
 * Never imported by the Worker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

const SCHEMA_ROOT = fileURLToPath(new URL("./schemas/2026-08-25/", import.meta.url));

interface SchemaSource {
  version: string;
  source: string;
  files: string[];
}

export const UCP_SCHEMA_SOURCE = JSON.parse(readFileSync(join(SCHEMA_ROOT, "SOURCE.json"), "utf8")) as SchemaSource;

let ajv: Ajv2020 | null = null;

function schemaRegistry(): Ajv2020 {
  if (ajv) return ajv;
  // UCP schemas carry annotation keywords of their own (`ucp_request`, `name`).
  const registry = new Ajv2020({ strict: false, allErrors: true });
  addFormats(registry);
  for (const file of UCP_SCHEMA_SOURCE.files) {
    registry.addSchema(JSON.parse(readFileSync(join(SCHEMA_ROOT, file), "utf8")));
  }
  ajv = registry;
  return registry;
}

/** A validator for `<schema path>#<pointer>`, e.g. `profile.json#/$defs/business_schema`. */
export function ucpValidator(ref: string): ValidateFunction {
  const id = `${UCP_SCHEMA_SOURCE.source}${ref}`;
  const validate = schemaRegistry().getSchema(id);
  if (!validate) throw new Error(`No vendored UCP schema for ${id}`);
  return validate;
}

/** The validation errors of a document (empty when it conforms). */
export function ucpSchemaErrors(ref: string, document: unknown): ErrorObject[] {
  const validate = ucpValidator(ref);
  return validate(document) ? [] : [...(validate.errors ?? [])];
}
