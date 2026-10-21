# Scalius CLI

Run a Scalius Commerce store from the terminal or from any agent (Claude Code, Codex, Cursor, OpenCode, Pi). One command connects everything:

```sh
npx scalius@latest init --server https://api.yourstore.com
```

`init` asks for one approval in the browser, installs the Scalius skills and the `scalius` MCP server into every agent it finds, and checks the result with `scalius doctor`. Restart the agent and ask it: "How did my store do today?"

Requires Node.js 22.12 or newer. The CLI never accepts arbitrary routes, methods, headers or database commands: it runs only the reviewed operations the store publishes.

## What init does

1. **Pairs once.** It opens `/connect` on the store, the merchant approves the shown code, and the credential is saved in the Scalius config directory (`0700` directory, `0600` file; `SCALIUS_CONFIG_HOME` overrides the location). This is the only login.
2. **Connects each agent** (`--harness auto` by default):

   | Agent | Installed as |
   |---|---|
   | Claude Code | the `scalius` plugin in `~/.claude/skills/scalius` (skills and MCP server, `scalius@skills-dir`); older versions get the skills plus `claude mcp add --scope user` |
   | Codex | the `scalius@scalius-local` plugin from a local marketplace (`codex plugin add`); older versions get the skills plus `codex mcp add` |
   | Cursor | skills in `~/.cursor/skills`, server in `~/.cursor/mcp.json` |
   | OpenCode | skills in `~/.config/opencode/skills`, server in `opencode.json` |
   | Pi, other Agent Skills clients | skills; init prints the MCP entry to add |

   The MCP server is local: the agent starts `scalius mcp`, a stdio server that forwards each MCP message to `https://<store>/api/v1/mcp/dashboard` with the paired credential. The credential never enters the agent's configuration, and the agent and the CLI share one login.
3. **Verifies** with `scalius doctor`.

Running `init` again updates skills and registrations in place. Options: `--harness claude,codex`, `--storefront` (also connect the buyer tools; a second approval), `--no-open` (print the link instead of opening a browser), `--no-auth`, `--profile-name <name>`.

## Commands

```text
scalius init [--server <origin>] [--harness auto|claude,codex,cursor,opencode,pi,agents] [--storefront] [--no-auth] [--no-open]
scalius doctor [--harness ...] [--surface dashboard|storefront]
scalius mcp [--surface dashboard|storefront]            stdio MCP server (agents launch this)

scalius ask "<question>"                                 = scalius_answer
scalius search "<goal>" [--limit 1-10]                   = scalius_search
scalius describe <operationId...> [--full|--examples]    = scalius_describe
scalius read <operationId> [--input j|@f|-] [--limit n] [--cursor c] [--all] [--ndjson] [--max-bytes n]
scalius write <operationId> [--input ...] [--dry-run] [--yes] [--approval <id>] [--idempotency-key auto|<key>]
scalius batch --input '{"steps":[...]}' [--dry-run] [--yes]
scalius bulk prices  (--ids sku,.. | --filter 'category=<id>') (--set <amount> | --percent <n> | --amount <amount>) [--minor] [--dry-run] [--yes] [--wait]
scalius bulk stock   (--items sku=qty,.. | --ids sku,.. --quantity <n>) [--location <id>] [--reason <text>]
scalius bulk tags    (--ids cus,.. | --filter 'tag=VIP,minOrders=4') [--add a,b] [--remove c]
scalius bulk status  (--ids prod,.. | --filter ...) --status active|draft
scalius bulk publish (--ids prod,.. | --filter ...) --channels ch,.. --action publish|unpublish
                     prices: amounts are in the store currency (--set 1500 is 1,500.00 BDT; --amount -100 takes 100 off);
                     the CLI reads the currency and its decimals from the store; --minor passes minor units (--set 150000 --minor)
                     prices, stock: a SKU is its code (TS-RED-M, any case) or its id (var_...); the CLI finds codes with
                     scalius read dashboard.resources.variants.lookup --input '{"body":{"skus":["TS-RED-M"]}}' (up to 90 codes)
                     a run in which every item is refused (an unknown SKU is not_found) exits 5 with the reasons, never ok:true
                     any kind: [--input '{"body":{...}}'] sends the raw body instead of the flags
scalius export <orders|customers|products|inventory|report> --out <file> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
scalius media upload <files...> --yes

scalius auth login|status|logout|revoke|token import
scalius profile list|use|show
scalius skill install [--harness <name>] [--force]

Global: --profile <name>  --output human|json  --select <pointers>  --jq <expression>
```

`ask`, `search`, `describe`, `read`, `write` and `batch` call the store's MCP tools (`scalius_answer`, `scalius_search`, `scalius_describe`, `scalius_read`, `scalius_write`), so the CLI and an agent get the same dry runs, approvals, response budgets and error hints. Compatibility commands from 0.2 remain: `setup`, `workflow resolve|read`, and `operations search|describe|run|batch|refresh` (the REST lane for raw file uploads, artifacts and browser continuations).

## Output

- JSON when stdout is not a terminal, text on a terminal; `--output` forces either.
- One envelope on stdout: `{ok, data, meta:{operationId, requestId, nextCursor, hasMore, total, truncated, replayed, idempotencyKey}}`.
- Errors on stderr: `{ok:false, error:{code, message, status, retryable, hint, current, field, requestId}}`.
- `--select /items/*/id,/total` keeps only those JSON pointers (sent to the server for reads).
- `--jq '<expr>'` filters `data` with a built-in jq subset (paths, `[]`, pipes, `select`, `map`, `length`, `keys`, `sort_by`, `group_by`, object and array construction, `@csv`, `@tsv` and more); strings print raw.
- `read --all` follows `nextCursor` to the end and prints one record per line (NDJSON). A page cut to the byte budget is fetched again with fewer rows, so no row is skipped; `429` waits for `retryAfterMs`.
- `--help --json` prints the command tree, flags and exit codes.

## Changes and approval

- `--dry-run` validates and previews a change and writes nothing (exit 11). A prices dry run names the store currency and shows the change in it (`Currency: BDT (2 decimal places); set every price to 1500.00 BDT.`); the server's before and after rows stay in minor units.
- A destructive or financial change, a security change (a security read needs none), and any operation the registry marks `confirmation: required` needs a person's approval while the grant's approval policy is on; it applies to `write`, `batch` and `bulk` alike. On a terminal the CLI offers the store's dialog and asks you there. Elsewhere (a pipe, an agent) the store answers 428 `confirmation_required` with the summary and an approval link for the grant's owner; the command sends nothing more and exits 10. Once they approve in the dashboard (within 5 minutes), run the same command again with `--approval <id>`: it runs once, for exactly that input. `--yes` never approves a gated change. A personal access token always gets the dashboard link.
- Every write that takes an idempotency key gets one automatically (`sck_...`), reused for every retry within the invocation and printed in `meta.idempotencyKey`; pass `--idempotency-key <key>` to replay an earlier attempt.

## Exit codes

`0` ok, `2` usage, `3` authentication, `4` authorization, `5` validation, `6` conflict, `7` temporary (retry), `8` server or contract, `10` needs the merchant's approval (nothing written), `11` dry run only (nothing written), `130` interrupted.

## Skills and plugins

The package is itself a Claude Code plugin and a Codex plugin: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `.mcp.json` (runs `npx scalius@<version> mcp`) and `skills/`. The eight skills are a `scalius` router plus `scalius-insights`, `scalius-catalog`, `scalius-sales`, `scalius-content`, `scalius-settings`, `scalius-marketing` and `scalius-storefront`. Each focused skill carries `references/recipes.md` (common merchant tasks, step by step) and `references/workflows.md` (the reviewed workflow routes). Both are generated from the operation manifest by `pnpm --filter scalius generate:recipes`; a test fails when they are stale or reference an operation or route that no longer exists.

## Files, artifacts and continuations

`media upload` takes 1 to 50 files, checks signature, extension and size, runs the resumable upload and returns the committed media ids. Images (JPEG, PNG, GIF, WebP, AVIF) are limited to 20 MiB and video (MP4, WebM) to 100 MiB. For JPEG, PNG, WebP and AVIF the CLI also encodes the WebP rendition ladder locally with the optional `sharp` dependency; without it the upload still succeeds and renditions stay `pending`.

`export` saves a reviewed CSV export atomically (`--overwrite` replaces a file); product and inventory exports join their pages into one file with one header.

`operations run` is the REST lane for what MCP cannot carry: `--file field=@path` for multipart fields, `--file <path>` for raw uploads (streamed with an exact `Content-Length`), and `--save <path>` for artifact responses (media type, disposition, filename and length are checked before the file is published). A hosted continuation opens a one-time page served from `127.0.0.1` that passes its fields to the target with `postMessage`; the fields never appear in a URL, argument, output, cache or credential file.

## CI

Set `SCALIUS_SERVER` and `SCALIUS_TOKEN` (a personal access token); nothing is written to disk. JSON output and exit codes make every command scriptable.
