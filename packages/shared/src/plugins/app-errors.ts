// The sealed app-facing error codes (audit L5): every `error.code` an app
// can branch on, with the HTTP status the platform answers it with. Two
// places carry them:
//
//   - a refusal of `ctx.*` (`ctx.objects`, `ctx.kv`, `ctx.http`, `ctx.jobs`,
//     ...) throws `PluginPlatformError` whose `code` is one of these (the
//     bridge forwards only these; anything else reads `internal_error`);
//   - a refused `ctx.api.call` (and the same stable operation over HTTP)
//     answers `{ ok: false, status, error: { code, message } }` with one of
//     these as `code`.
//
// One code per fact: `object_invalid` (never `object_invalid_record`),
// `installation_inactive` (never `plugin_inactive`), `internal_error` (never
// `internal`). The table is part of the versioned plugin ABI
// (`abi.protocol.snapshot.json`): a code is only ever added, and its status
// never changes. `apps/api/src/app-error-codes.test.ts` holds the producers
// an app reaches (the bridge, the app API dispatch, retries and the stable
// route modules) to it.

export interface AppErrorCodeEntry {
  /** The HTTP status an operation answers with it (a `ctx.*` refusal carries the code only). */
  readonly status: number;
  /** What happened, and what the app does about it. */
  readonly meaning: string;
}

export const APP_ERROR_CODES = {
  // ── Any operation ──
  validation_error: { status: 400, meaning: "A path, query or body value the operation's schema refuses; details.issues names the fields." },
  invalid_cursor: { status: 400, meaning: "The cursor is not one this list issued for this order; start again from the first page." },
  unauthorized: { status: 401, meaning: "No valid credential." },
  forbidden: { status: 403, meaning: "The caller may not do this to this resource." },
  not_found: { status: 404, meaning: "The resource does not exist (or is not visible to the caller)." },
  conflict: { status: 409, meaning: "The resource is in a state that refuses the write; read it again." },
  payload_too_large: { status: 413, meaning: "The request body is over the operation's limit." },
  rate_limited: { status: 429, meaning: "Too many calls; retry after details.retryAfterSeconds." },
  internal_error: { status: 500, meaning: "The platform failed; nothing was promised. Retry with the same Idempotency-Key." },
  service_unavailable: { status: 503, meaning: "A dependency is unavailable right now; retry later." },

  // ── ctx.api.call ──
  api_unknown_operation: { status: 404, meaning: "No operation has that app name (the message names the app name for an operation id)." },
  api_operation_not_stable: { status: 403, meaning: "The operation is beta or internal; a third-party app calls stable operations only." },
  api_operation_forbidden: { status: 403, meaning: "No approved scope of the app covers the operation." },
  api_invalid_input: { status: 400, meaning: "The call's path, query, body or idempotencyKey is malformed (not a schema refusal)." },
  unknown_body_property: { status: 400, meaning: "The body names a field the operation does not declare." },
  installation_inactive: { status: 401, meaning: "The app is not active (stopped, failing, updating or uninstalled)." },
  contact_scope_required: { status: 403, meaning: "Filtering or searching by a buyer contact field needs its read_customer_* scope." },
  app_principal_required: { status: 403, meaning: "Only an app calls this operation." },
  app_scope_required: { status: 403, meaning: "The app's approved, active grant lacks the scope the operation needs." },

  // ── Retries (the Idempotency-Key header) ──
  idempotency_key_required: { status: 400, meaning: "The operation needs an Idempotency-Key." },
  idempotency_not_supported: { status: 400, meaning: "The operation takes no Idempotency-Key." },
  idempotency_key_invalid: { status: 400, meaning: "The Idempotency-Key is not 8 to 200 printable characters." },
  idempotency_key_reused: { status: 422, meaning: "The key was used for a different request; use a new key." },
  idempotency_in_progress: { status: 409, meaning: "The first request with this key is still running; retry shortly." },
  idempotency_outcome_unknown: { status: 409, meaning: "A first request with this key may have committed before its answer was lost; read to check, and repeat with a new key only if it is missing." },
  idempotency_secret_not_replayed: { status: 409, meaning: "The first response carried a one-time secret, which is never replayed." },

  // ── Revisions and states (409: read the resource again, then retry) ──
  product_revision_conflict: { status: 409, meaning: "The product changed since its revision was read." },
  product_state_conflict: { status: 409, meaning: "The product is in a state (trashed, live) that refuses the write." },
  brand_revision_conflict: { status: 409, meaning: "The brand changed since its revision was read." },
  brand_state_conflict: { status: 409, meaning: "The brand is in a state that refuses the write." },
  category_revision_conflict: { status: 409, meaning: "The category changed since its revision was read." },
  category_state_conflict: { status: 409, meaning: "The category is in a state that refuses the write." },
  collection_revision_conflict: { status: 409, meaning: "The collection changed since its revision was read." },
  page_revision_conflict: { status: 409, meaning: "The page changed since its revision was read." },
  page_state_conflict: { status: 409, meaning: "The page is in a state that refuses the write." },
  promotion_revision_conflict: { status: 409, meaning: "The discount changed since its revision was read." },
  promotion_state_conflict: { status: 409, meaning: "The discount is in a state that refuses the write." },
  price_list_revision_conflict: { status: 409, meaning: "The price list changed since its revision was read." },
  navigation_revision_conflict: { status: 409, meaning: "The menu changed since its revision was read." },
  object_revision_conflict: { status: 409, meaning: "The object type changed since its revision was read." },
  supplier_revision_conflict: { status: 409, meaning: "The supplier changed since its revision was read." },
  purchase_order_revision_conflict: { status: 409, meaning: "The purchase order changed since its revision was read." },
  purchase_order_state_conflict: { status: 409, meaning: "The purchase order's status refuses the write (an ordered one's lines, a received or cancelled one)." },
  inventory_transfer_revision_conflict: { status: 409, meaning: "The stock transfer changed since its revision was read." },
  order_revision_conflict: { status: 409, meaning: "The order changed since its revision was read (a return request names the order's revision)." },
  admin_order_create_request_mismatch: { status: 409, meaning: "The order request's key already belongs to another request: details.state is committed (details.orderId is the order it placed: read it, never place it again), processing (retry shortly) or failed (details.canRetryWithNewKey)." },
  return_revision_conflict: { status: 409, meaning: "The return changed since its revision was read." },
  return_command_in_progress: { status: 409, meaning: "Another return command (a receipt, a racing request) is running on the order; retry shortly with the same key." },
  segment_revision_conflict: { status: 409, meaning: "The customer segment changed since its revision was read." },
  inventory_transfer_state_conflict: { status: 409, meaning: "The stock transfer's status refuses the write (a shipped one's lines, nothing left in transit)." },
  review_revision_conflict: { status: 409, meaning: "The review changed since its revision was read." },
  review_state_conflict: { status: 409, meaning: "The review's status cannot move to the one asked (a withdrawn review, a rejected one back to pending)." },

  // ── Domain refusals of stable operations ──
  price_changed: { status: 409, meaning: "A price moved since it was read; read it again." },
  phone_required: { status: 400, meaning: "The order needs the buyer's phone (cash on delivery, invoices, Bangladesh)." },
  sku_taken: { status: 409, meaning: "Another SKU has this code or barcode." },
  segment_name_taken: { status: 409, meaning: "Another customer segment has this name (any case)." },
  media_dependency_conflict: { status: 409, meaning: "The file is still used where it cannot be removed." },
  inventory_location_shortfall: { status: 409, meaning: "The location holds fewer units than the move takes." },
  quantity_exceeds_open: { status: 409, meaning: "A receipt takes more units than its line still has to come (ordered and not received, or in transit)." },
  stock_committed: { status: 409, meaning: "Fewer units are free to move than the move takes: the rest are committed to orders." },
  variant_retired: { status: 409, meaning: "The SKU was retired from its product; restore it or leave it out." },
  supplier_has_open_purchase_orders: { status: 409, meaning: "Purchase orders are still expected from the supplier; receive or cancel them first." },
  cost_scope_required: { status: 403, meaning: "Purchase order events carry costs: the app's endpoint needs read_product_costs to receive them." },
  conversation_scope_required: { status: 403, meaning: "Conversation events carry buyers' messages: the app's endpoint needs read_conversations to receive them." },
  menu_in_trash: { status: 409, meaning: "The menu is in the trash." },
  handle_unresolved: { status: 422, meaning: "No category or collection has the handle; details.unresolved lists them." },
  section_not_found: { status: 404, meaning: "No section with that id is on the page." },
  template_not_owned: { status: 403, meaning: "An app applies only its own templates." },
  template_unavailable: { status: 422, meaning: "The template does not fit the store's theme." },
  object_type_taken: { status: 409, meaning: "An object type with that name exists." },
  object_limit: { status: 409, meaning: "The store holds the most object types it may." },
  payment_declined: { status: 422, meaning: "The provider declined the charge; nothing was taken." },
  payment_outcome_unknown: { status: 503, meaning: "The provider's answer is unknown; retry with the same Idempotency-Key to learn it." },
  payment_in_progress: { status: 409, meaning: "Another charge of the order is still running." },
  payment_not_possible: { status: 409, meaning: "The order or saved method cannot be charged now." },
  payment_method_customer_mismatch: { status: 422, meaning: "The saved method belongs to another customer than the order's." },
  provider_invalid_response: { status: 503, meaning: "A provider answered something invalid (another order, a malformed answer); treat the outcome as unknown and retry with the same Idempotency-Key." },
  app_gift_card_limit: { status: 403, meaning: "The app reached the merchant's daily gift card value limit." },
  payout_provider_unavailable: { status: 422, meaning: "The payout provider is not an installed, active, set-up payout provider; nothing was recorded." },
  payout_request_mismatch: { status: 409, meaning: "The Idempotency-Key already sent a different payout (details.payoutId); use a new key for a new payout." },
  payout_reversal_unsupported: { status: 422, meaning: "The payout's provider cannot reverse payouts (it does not implement reversePayout); nothing was recorded." },
  payout_not_reversible: { status: 409, meaning: "Only a paid payout can be reversed (details.status is the payout's)." },
  payout_reversal_exceeds_payout: { status: 409, meaning: "The reversal takes back more than the payout has left to give back (details.reversibleMinor), or the payout already has 20 reversals." },
  payout_reversal_currency_mismatch: { status: 422, meaning: "A reversal is in its payout's currency (details.currency)." },
  payout_reversal_request_mismatch: { status: 409, meaning: "The Idempotency-Key already reversed another amount or payout (details.reversalId); use a new key for a new reversal." },
  payout_reversal_outcome_unknown: { status: 503, meaning: "The reversal is recorded (details.reversalId) but the provider's answer is unknown; repeat the same request with the same Idempotency-Key to resume it, never applied twice." },
  payout_outcome_unknown: { status: 503, meaning: "The payout is recorded (details.payoutId) but the provider's answer is unknown; repeat the same request with the same Idempotency-Key to resubmit it, never sent twice." },
  conversation_channel_unavailable: { status: 422, meaning: "The thread's chat channel has no installed, active, set-up messaging provider to carry a public reply; add an internal note or set the app up." },
  sales_channel_product_unpublished: { status: 422, meaning: "An order or quote on an app's sales channel names a product not published to it (details.productIds); publish it to the channel first. Nothing was written." },
  pos_sales_channel_not_owned: { status: 403, meaning: "An app sells in person only from its own sales channel (`<app id>:<channel>`, declared in its manifest)." },
  pos_location_unavailable: { status: 422, meaning: "The sale's location does not exist or is archived." },
  pos_location_not_on_channel: { status: 422, meaning: "The sales channel does not sell from the sale's location." },
  pos_staff_unknown: { status: 422, meaning: "No active staff member has the sale's staffMemberId." },
  pos_tender_short: { status: 422, meaning: "The sale's tenders do not cover its total; nothing was written." },
  pos_change_without_cash: { status: 422, meaning: "The tenders exceed the total by more than their cash: only cash gives change; nothing was written." },
  digital_access_order_unpaid: { status: 409, meaning: "The order is not paid yet: digital goods go out once it is." },
  digital_access_order_closed: { status: 409, meaning: "The order was cancelled, refunded or returned, so it gives no digital access." },
  digital_access_order_on_hold: { status: 409, meaning: "The order is on hold for review; digital access waits for the hold's release." },
  digital_access_awaiting_confirmation: { status: 409, meaning: "The store hands digital goods over only after staff confirm the order." },
  digital_access_nothing_owed: { status: 409, meaning: "Every unit of the order line was refunded, so it gives no digital access." },
  digital_access_keys_not_owed: { status: 409, meaning: "Licence keys go out only with a line's delivery; the line was handed over without this key pool." },
  digital_asset_not_on_line: { status: 422, meaning: "The order line's product and variant do not deliver this digital item." },
  digital_asset_not_ready: { status: 409, meaning: "The digital item is not ready to deliver (its file is still uploading, or it is archived)." },
  digital_keys_exhausted: { status: 409, meaning: "The licence-key pool has too few keys for the line; the store imports more." },
  reviews_disabled: { status: 403, meaning: "The store is not taking reviews (its reviews setting is off)." },
  review_exists: { status: 409, meaning: "The buyer already has a live review of the product, or the order line has its review; details.reviewId names it." },
  review_not_eligible: { status: 409, meaning: "The order line was not handed over on a delivered order, or its review window closed." },
  review_not_verifiable: { status: 422, meaning: "A verified purchase needs a delivered order line of the review's customer; nothing was written." },

  // ── ctx refusals (PluginPlatformError.code) ──
  object_undeclared_type: { status: 400, meaning: "The manifest declares no object type of that name." },
  object_invalid_id: { status: 400, meaning: "The record id is not valid." },
  object_invalid: { status: 400, meaning: "The record, patch or type does not match its declaration." },
  object_record_too_large: { status: 413, meaning: "The record is over the size limit." },
  object_response_too_large: { status: 400, meaning: "A single record is over the list response budget; get it directly." },
  object_invalid_index_value: { status: 400, meaning: "An indexed field holds a value the index cannot store." },
  object_unindexed_query: { status: 400, meaning: "The query filters or sorts by a field no index leads with." },
  object_invalid_cursor: { status: 400, meaning: "The object query cursor is not valid." },
  object_unique_violation: { status: 409, meaning: "Another record holds the unique value." },
  object_conflict: { status: 409, meaning: "The record changed since it was read (or exists when it must not)." },
  object_invalid_batch: { status: 400, meaning: "The batch is empty, too large or repeats a record." },
  object_not_found: { status: 404, meaning: "The record does not exist." },
  object_forbidden: { status: 403, meaning: "The app may not reach that object type." },
  object_out_of_range: { status: 400, meaning: "increment would leave the field's bounds; nothing changed." },
  kv_invalid_key: { status: 400, meaning: "The key is not valid." },
  kv_value_too_large: { status: 413, meaning: "The value is over the size limit." },
  kv_invalid_ttl: { status: 400, meaning: "The TTL is not valid." },
  kv_conflict: { status: 409, meaning: "compareAndSet found another revision." },
  kv_invalid_revision: { status: 400, meaning: "The revision is not valid." },
  http_not_allowed: { status: 403, meaning: "The host is not on the app's approved hosts." },
  http_invalid_request: { status: 400, meaning: "The request is malformed or sets a forbidden header." },
  http_too_many_redirects: { status: 400, meaning: "The request redirected too many times." },
  http_timeout: { status: 504, meaning: "The remote host did not answer in time." },
  http_failed: { status: 502, meaning: "The request could not be completed." },
  custom_fields_undeclared: { status: 400, meaning: "The manifest declares no such custom field." },
  custom_fields_invalid: { status: 400, meaning: "A custom field value does not match its definition." },
  messaging_not_allowed: { status: 403, meaning: "The grant does not allow this message." },
  messaging_recipient_not_allowed: { status: 400, meaning: "The recipient is neither a customer, staff nor a declared recipient, and the app lacks send_messages_any." },
  messaging_invalid: { status: 400, meaning: "The message is malformed." },
  messaging_unavailable: { status: 503, meaning: "No delivery channel is available." },
  timeline_not_allowed: { status: 403, meaning: "The grant does not allow writing the order timeline." },
  timeline_undeclared: { status: 403, meaning: "The manifest declares no such timeline entry." },
  timeline_invalid: { status: 422, meaning: "The timeline entry is malformed." },
  timeline_not_found: { status: 404, meaning: "The order does not exist." },
  orders_not_allowed: { status: 403, meaning: "The grant does not allow the order action." },
  orders_invalid: { status: 422, meaning: "The order action is malformed." },
  orders_not_found: { status: 404, meaning: "The order does not exist." },
  orders_hold_not_found: { status: 404, meaning: "The app placed no hold on the order." },
  orders_conflict: { status: 409, meaning: "The order changed since its revision was read; read it again." },
  customers_not_allowed: { status: 403, meaning: "The grant does not allow the customer action." },
  customers_invalid: { status: 422, meaning: "The customer action is malformed." },
  customers_not_found: { status: 404, meaning: "The customer does not exist." },
  customer_roles_limit: { status: 409, meaning: "The customer holds the most app roles they may." },
  jobs_undeclared: { status: 404, meaning: "The manifest declares no such job." },
  jobs_invalid: { status: 422, meaning: "The job input is malformed." },
  jobs_limit: { status: 429, meaning: "The app runs the most jobs it may." },
  jobs_not_found: { status: 404, meaning: "The job does not exist." },
  jobs_key_reused: { status: 422, meaning: "The job key was used for a different input." },
  jobs_unavailable: { status: 501, meaning: "This platform version does not run app background jobs." },
  uploads_invalid: { status: 422, meaning: "The upload id, offset or length is malformed, or the offset falls inside a character." },
  uploads_not_found: { status: 404, meaning: "The upload does not exist, is another app's, or was deleted (by the app, or by the platform after its lifetime)." },
  uploads_unavailable: { status: 501, meaning: "This platform version does not keep app uploads." },
  customers_unavailable: { status: 501, meaning: "This platform version does not keep app customer roles." },
  settings_key_unavailable: { status: 503, meaning: "The app's secret settings cannot be read right now." },
  quota_storage: { status: 507, meaning: "The app is over its storage quota." },
  quota_subrequests: { status: 429, meaning: "The run made the most platform calls it may." },
} as const satisfies Record<string, AppErrorCodeEntry>;

export type AppErrorCode = keyof typeof APP_ERROR_CODES;

/** The codes a `ctx.*` object refusal carries (`ObjectError`). */
export type ObjectErrorCode = Extract<AppErrorCode, `object_${string}`>;

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && Object.hasOwn(APP_ERROR_CODES, value);
}
