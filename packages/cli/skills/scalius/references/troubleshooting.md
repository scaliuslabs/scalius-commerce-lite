# Troubleshooting

A failed call returns `{ok:false, error:{code, status, message, retryable, hint, current, field}}` (MCP `isError: true`; CLI JSON on stderr). Read `hint` first: it names the next call.

| Code or status | What to do |
|---|---|
| `confirmation_required` (428; CLI exit 10) | Nothing was written. Give the merchant `confirmation.approvalUrl`; after they approve there, resend with `approvalId` (CLI `--approval <id>`). `--yes` never approves. |
| `confirmation_declined` | The merchant said no. Stop. |
| `confirm_token_invalid` | The input changed or the token expired (10 minutes): dry run again and ask again. |
| `confirm_token_used` | The approved write already ran. Read to verify; do not repeat it. |
| 409, a stale revision | Someone changed it. `current` holds the new revision: reread, reapply only the requested fields, retry once. |
| `idempotency_in_progress` | Wait 2 seconds and retry with the same idempotency key. |
| `idempotency_outcome_unknown` | The first call stopped before its answer was kept and may have taken effect. Read to check; repeat with a new key only if it is missing. |
| 422, `invalid_input` | `field` names the input at fault; `scalius_describe` shows the shape. |
| `operation_not_found` | The id is wrong or this grant cannot run it: `scalius_search` again. |
| 401, `credential_rejected` (exit 3) | Run `scalius doctor`, then `scalius init` to pair again. |
| 403 (exit 4) | The grant lacks the permission. Tell the merchant which one; do not look for another route. |
| 429, `rate_limited` (exit 7) | Wait `retryAfterMs`, then retry. |
| 503, `retryable: true` | Retry once after a short wait. |
| `dry_run_unsupported`, support `none` | The input is valid but nothing previews: read the resource first and show the merchant what will change. |
| `page_too_large` | Add `select` pointers or a smaller `limit`. |

## CLI exit codes

0 ok, 2 usage, 3 sign in again, 4 not permitted, 5 invalid input, 6 conflict, 7 try again later, 8 server, 10 needs the merchant's approval (nothing written), 11 dry run only (nothing written), 130 interrupted. `scalius --help --json` prints every command, flag and code.

## Connection

| Symptom | Fix |
|---|---|
| The agent shows no `scalius` tools | `scalius doctor`, then restart the agent |
| "Scalius is not connected" from the MCP server | `scalius init --server <origin>` |
| Skills from an older version | `scalius init` again |
| A remote shell cannot open a browser | `scalius init --no-open` and open the printed link on any device |
