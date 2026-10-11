# Conversations

Buyer and store threads: order threads, store threads, messages, image attachments, and support-request cases on the order thread. Review and warranty-claim threads use the same tables. Audience: contributors and coding agents.

## Entries

`index.ts` is the server entry. `browser.ts` is the closed entry: the vocabulary and limits from `@scalius/shared/conversation`, the buyer projection (`projection.ts`) and the view types (`types.ts`).

Main files:

- `threads.ts`: access, posting, reads, read markers, the staff inbox, store threads.
- `attachments.ts`: stage, authorize, serve and sweep image attachments.
- `order-cases.ts`: support requests as structured cases on the order thread.
- `projection.ts`: the only way a stored line reaches a buyer.

## Layer and imports

- Layer L9. Imports `notifications` (outbox rows) and `orders` (support-request reads and order events).
- Imported by `agent-storefront` and `warranty` (claim threads).

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `conversations` | One thread. `subject_type` is `order`, `store`, `warranty_claim` or `review`. Unique order thread per order. Unique `(subject_type, subject_id)`. `status` is `open` (waits on staff), `pending` (waits on the buyer) or `closed`. `last_seq` and the two read markers bound unread queries. `version` is the CAS token. |
| `conversation_messages` | Append-only. Unique `(conversation_id, seq)`. `kind` is `message` or `event`. `visibility` is `public` or `internal`. Optional unique `client_message_key` per thread. Body up to 5,000 characters. |
| `conversation_attachments` | One image. `r2_key` under `private/conversations/`. WebP only, at most 5 MiB. Unattached rows have no `message_id`. |

Triggers refuse these writes: a `last_seq` step other than one, a message `seq` that differs from the thread's `last_seq`, an identity change, a thread or message delete, a message update, and a second attach of one image.

## Rules

- Posting is one batch. It advances `last_seq` by one with a CAS on the old value, inserts the message with that `seq`, attaches its images and writes its notification outbox rows. The post retries up to 3 times, so `seq` stays gap-free under concurrency.
- On an order thread, buyer access derives from the order: the account that owns it, or a guest holding the order's receipt proof. The thread carries no customer. A store thread belongs to a verified account: claimed, with at least one proven contact.
- Limits (`CONVERSATION_LIMITS`): 30 buyer messages per thread in 24 hours, 5 open store threads per account, 3 images per message, 50 messages per page.
- Staff unread counts only public buyer message lines after `staff_read_seq`; replies, notes and events never acknowledge incoming lines. Only the explicit read endpoint advances the staff marker. Page counts use indexed message suffixes for the returned threads; the navigation summary reads transactionally maintained global and assignee counters, independent of thread/message history, while unread still includes every status. Buyer markers keep their existing rules.
- A buyer sees public lines only. Internal staff notes never pass the projection. Staff identity collapses to "the store". Event data passes only the keys `type`, `status`, `fromStatus`, `toStatus`, `requestId`.
- The API sniffs each upload, re-encodes it to WebP through the `IMAGES` binding (this strips EXIF and GPS data), and stores it under `private/conversations/<conversation>/<attachment>`. Browsers may upload JPEG, PNG or WebP. Every read passes a thread access check. An uploader holds at most 6 unattached images per thread. `sweepOrphanConversationAttachments` deletes unattached images after 1 hour.
- Conversations never write `customers` or `orders` and never change payments, stock, delivery or order status. `scripts/check-source-policies.mjs` enforces this.
- A support-request case keeps its one-active-per-order key, return link and refund-blocking rules (read side in `orders`). The buyer's words become the first public message. Status changes become event lines. The case row, thread CAS and messages commit in one batch.
- Message bodies never enter URLs, logs, KV keys or queue payloads. Logs carry ids only.
- DVC: the registry marks all three tables private. No public cached read depends on them.

## Routes

Admin permissions are in `packages/core/src/auth/rbac/route-permissions/conversations.ts`. Route files under `apps/api/src/routes/`: `admin/conversations.ts`, `customer-auth/conversations.ts` and `storefront-orders/conversation.ts`.

| Method and path | Permission |
|-----------------|------------|
| `GET /api/v1/admin/conversations`, `GET /summary`, `GET /{id}`, `GET /order/{orderId}`, `GET /{id}/attachments/{attachmentId}`, `POST /{id}/read` | `conversations.view` |
| `POST /api/v1/admin/conversations/{id}/messages`, `POST /order/{orderId}/messages`, `POST /attachments`, `PATCH /{id}` | `conversations.reply` |
| `/api/v1/customer-auth/conversations` (list, `GET /unread`, `POST`, `GET /{id}`, `POST /{id}/messages`, `POST /{id}/read`), `/orders/{id}/conversation` (`GET`, `POST`), `POST /conversation-attachments`, `GET /conversations/{id}/attachments/{attachmentId}` | customer session |
| `/api/v1/orders/receipt/{id}/conversation` (`GET`, `POST`, `POST /read`), `POST /receipt/{id}/conversation-attachments`, `GET /receipt/{id}/conversation/attachments/{attachmentId}` | receipt proof |

Order support requests use `POST /api/v1/orders/receipt/{id}/support-requests`, the customer order routes, and `PATCH /api/v1/admin/orders/{id}/support-requests/{requestId}/status` (see `order-cases.ts`).
