// Address rules (MARKETS-DESIGN D7): one country's libaddressinput rules in
// Saleor's `addressValidationRules` shape, so storefront and dashboard forms
// render the fields a country uses, in its order, with its labels, admin areas
// and postal pattern. The table is code, not data: these are public reads
// whose answer changes only with a release (the Worker version is in every
// cache key), and the storefront batches them like any public read. Browser
// bundles never carry the whole table.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ADDRESS_FIELDS } from "@scalius/shared/address";
import { ADDRESS_COUNTRY_CODES, addressRulesFor } from "@scalius/shared/address-metadata";
import { NotFoundError } from "../utils/api-error";
import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const fieldSchema = z.enum(ADDRESS_FIELDS);

export const addressRulesSchema = z.object({
  countryCode: z.string().length(2),
  /** libaddressinput's format line (`%N` name, `%O` company, `%A` lines, `%D`, `%C`, `%S`, `%Z`, `%n` new line). */
  format: z.string(),
  /** Form rows in the country's order; `line1` and `line2` are separate rows. */
  rows: z.array(z.array(fieldSchema)),
  allowedFields: z.array(fieldSchema),
  requiredFields: z.array(fieldSchema),
  /** Fields a label prints in upper case. */
  upperFields: z.array(fieldSchema),
  /** A whole-value, case-insensitive pattern; null accepts any postal code. */
  postalCodePattern: z.string().nullable(),
  postalCodeExamples: z.array(z.string()),
  /** Label types a form translates (`state`, `prefecture`, `emirate`; `city`, `post_town`; `zip`, `pin`, `eircode`). */
  labels: z.object({
    adminArea: z.string(),
    locality: z.string(),
    dependentLocality: z.string(),
    postalCode: z.string(),
  }),
  /** The admin areas to choose from (store `code`); empty means free text. */
  adminAreas: z.array(z.object({ code: z.string(), name: z.string(), isoCode: z.string().nullable() })),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.address_rules.countries",
  tags: ["Addresses"],
  summary: "List the countries addresses can be in",
  description: "Every ISO 3166-1 alpha-2 country the address rules know; an address in any other country is refused.",
  responses: {
    200: {
      description: "Countries",
      content: { "application/json": { schema: successEnvelope(z.object({ countries: z.array(z.string().length(2)) })) } },
    },
    ...errorResponses,
  },
});

app.openapi(listRoute, (c) => ok(c, { countries: [...ADDRESS_COUNTRY_CODES] }));

const getRoute = createRoute({
  method: "get",
  path: "/{countryCode}",
  operationId: "storefront.address_rules.get",
  tags: ["Addresses"],
  summary: "Get one country's address rules",
  description: "Allowed and required fields, field order, label types, admin areas, postal code pattern and examples (Saleor's addressValidationRules), from Google libaddressinput.",
  request: {
    params: z.object({ countryCode: z.string().regex(/^[A-Za-z]{2}$/) }),
  },
  responses: {
    200: {
      description: "Address rules",
      content: { "application/json": { schema: successEnvelope(addressRulesSchema) } },
    },
    ...errorResponses,
  },
});

app.openapi(getRoute, (c) => {
  const rules = addressRulesFor(c.req.valid("param").countryCode);
  if (!rules) throw new NotFoundError("No address rules for that country.");
  return ok(c, rules);
});

export { app as addressRuleRoutes };
