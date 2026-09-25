// Signed-in buyer warranty routes (Wave B design §5.2, §7.1): the account's
// warranties (active first, with the latest claim), photos for a claim that is
// about to be opened, and opening a claim. The claim thread then lives in the
// account Inbox (/customer-auth/conversations/{id}). Private, never cached;
// claim text never enters a URL or a log.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  listBuyerWarranties,
  openWarrantyClaim,
  stageWarrantyClaimAttachment,
} from "@scalius/core/modules/warranty";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { attachmentUploadResponseSchema } from "../../schemas/conversations";
import {
  buyerOpenClaimBodySchema,
  buyerWarrantySchema,
  claimAttachmentUploadRequest,
  openedClaimSchema,
  presentBuyerWarranty,
  warrantyIdSchema,
} from "../../schemas/warranty";
import {
  enforceBuyerWriteLimits,
  formText,
  readAndReencodeAttachment,
  readAttachmentForm,
} from "../../utils/conversation-http";
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

async function customerId(c: Context<{ Bindings: Env }>): Promise<string> {
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  return session.customerId;
}

const warrantyParam = z.object({ id: warrantyIdSchema });
const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };

app.openapi(createRoute({
  method: "get",
  path: "/warranties",
  tags: ["Customer Auth"],
  summary: "The account's warranties: active first, with time left and the latest claim",
  responses: {
    200: { description: "Warranties", content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(buyerWarrantySchema) })) } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const items = await listBuyerWarranties(c.get("db"), await customerId(c));
  return ok(c, { items: items.map((warranty) => presentBuyerWarranty(warranty, getCurrentPublicMediaUrl)) });
});

app.openapi(createRoute({
  method: "post",
  path: "/warranties/{id}/claim-attachments",
  tags: ["Customer Auth"],
  summary: "Upload one photo (JPEG, PNG or WebP, 5 MB or less) for the claim this form is about to open",
  description: "Multipart form with `file` and the claim form's `clientKey`. The photo is re-encoded to WebP (metadata removed), stays private, and is attached by id when the claim is opened within an hour.",
  request: { params: warrantyParam, body: { required: true, ...claimAttachmentUploadRequest } },
  responses: {
    201: { description: "Staged photo", content: { "application/json": { schema: successEnvelope(attachmentUploadResponseSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const customer = await customerId(c);
  const form = await readAttachmentForm(c);
  await enforceBuyerWriteLimits(c, "upload", { customerId: customer });
  const image = await readAndReencodeAttachment(c.env, form);
  const staged = await stageWarrantyClaimAttachment(c.get("db"), c.env.BUCKET, {
    warrantyId: c.req.valid("param").id,
    clientKey: formText(form, "clientKey") ?? "",
    actor: { kind: "customer", customerId: customer },
    ...image,
  });
  return created(c, {
    attachmentId: staged.id,
    conversationId: staged.conversationId,
    mediaType: staged.mediaType,
    sizeBytes: staged.sizeBytes,
    width: staged.width,
    height: staged.height,
  });
});

app.openapi(createRoute({
  method: "post",
  path: "/warranties/{id}/claims",
  tags: ["Customer Auth"],
  summary: "Open a warranty claim for an active warranty (the claim thread then lives in the Inbox)",
  request: { params: warrantyParam, body: { required: true, content: { "application/json": { schema: buyerOpenClaimBodySchema } } } },
  responses: {
    201: { description: "The claim and its conversation", content: { "application/json": { schema: successEnvelope(openedClaimSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const customer = await customerId(c);
  const body = c.req.valid("json");
  await enforceBuyerWriteLimits(c, "warranty-claim", { customerId: customer });
  const opened = await openWarrantyClaim(c.get("db"), {
    warrantyId: c.req.valid("param").id,
    actor: { kind: "customer", customerId: customer },
    description: body.description,
    clientKey: body.clientKey,
    attachmentIds: body.attachmentIds,
    quantity: body.quantity,
  }, { queue: c.env.JOBS_QUEUE });
  return created(c, opened);
});

export { app as customerWarrantyRoutes };
