# Scalius CLI

`scalius` discovers and runs the operations that a Scalius Commerce store publishes. It never accepts arbitrary routes, methods, request headers, or database commands.

The CLI reads the operation catalog, schemas, permissions, risk, revisions, idempotency, byte limits, artifacts, uploads, and browser continuations from the store's live OpenAPI contract (`GET /api/v1/openapi.json`). A new reviewed store operation becomes discoverable without a second hard-coded command catalog.

Requires Node.js 22.12 or newer.

```sh
npm install --global scalius

scalius auth login --server https://api.example.com
scalius auth login --server https://api.example.com --resource storefront --profile-name my-store-storefront
scalius --output json workflow read "How is my store doing today?" --surface dashboard
scalius --output json workflow resolve "Create a product with size/color variants and exact images" --surface dashboard
scalius operations search "what are today's sales?" --surface dashboard
scalius operations describe dashboard.products.create
scalius operations run dashboard.products.create --input @product.json --yes
scalius media upload hero.jpg orange.jpg blue.jpg --yes
scalius setup --harness codex --server https://api.example.com
```

You can also run it without a global install:

```sh
npx scalius --help
```

For CI, set `SCALIUS_SERVER` and `SCALIUS_TOKEN`. The CLI does not write the environment credential to disk. It stores profiles and interactive or imported credentials in the platform config directory (`SCALIUS_CONFIG_HOME` overrides it), with `0700` directory and `0600` file permissions.

## Commands

```text
scalius [--profile <name>] [--output human|json] <command>
scalius auth login --server <api-origin> [--resource dashboard|storefront] [--profile-name <name>] [--no-open]
scalius auth token import --server <api-origin> [--profile-name <name>]
scalius auth status
scalius auth logout
scalius auth revoke
scalius profile list
scalius profile use <name>
scalius profile show [name]
scalius workflow read <request> [--surface dashboard|storefront]
scalius workflow resolve <request> [--surface dashboard|storefront]
scalius operations search [query] [--surface dashboard|storefront] [--limit <1-100>]
scalius operations describe <operationId> [--full]
scalius operations refresh [--surface dashboard|storefront]
scalius operations run <operationId> [--input <json|@file|->] [--file <path|field=@path>]
    [--idempotency-key <key>] [--yes] [--save <path> [--overwrite]]
scalius operations batch --input <json|@file|-> [--yes]
scalius media upload <files...> [--folder-id <id>] --yes
scalius setup --harness <agents|codex|claude|opencode|pi> [--server <origin>] [--force]
scalius skill install [--harness <name>] [--force]
```

`ops` is an alias for `operations`.

Run `scalius setup` to install the bundled Agent Skills suite and print MCP instructions. The suite has one setup/router skill plus the focused insights, catalog, content, sales, settings, and storefront skills. The skills go to the native user location of Codex, Claude, OpenCode, or Pi, or to the cross-client `~/.agents/skills` directory. `--force` stages and replaces the whole suite, so no stale guide stays behind. Setup prints exact credential-free instructions for the two audience-specific MCP servers (`/api/v1/mcp/dashboard` and `/api/v1/mcp/storefront`). It never writes tokens into harness configuration. Pi loads the skills and the full CLI natively, but its core has no MCP client. For Pi, setup prints the separately installed `pi-mcp-adapter` package and a shared MCP configuration. It never installs that package.

The workflow is harness-neutral. Use `workflow read` for a supported data question. Otherwise resolve a natural-language goal, describe only the selected operations, request `--full` only while you build an exact input, run the operation, and verify with a bounded read. The resolver uses the versioned workflow catalog embedded in the live contract. It returns one reviewed plan, at most three choices, a safety control, or an explicit unsupported result. It never sends the full catalog to the model. The live contract, not a model-specific prompt, is authoritative for fields, RBAC, risk, revisions, idempotency, byte limits, artifacts, uploads, and continuations.

`workflow resolve` can read the public contract before pairing, so local planning works with `SCALIUS_SERVER=<origin>` and no credential. `workflow read`, `operations search`, `operations describe`, and every execution need a profile authenticated for the matching dashboard or storefront audience.

`workflow resolve` accepts normal merchant phrasing such as "today's sales", "orders needing fulfillment", "low stock issues", or "is my store healthy?". `operations search` is the low-level escape hatch for an exact operation ID or contract keyword. It does not rebuild multi-step goals. Without `--profile` or `--surface`, it searches the dashboard. An operation ID selects the authenticated dashboard or storefront profile for the active store origin. It never crosses to another store.

Dashboard MCP, storefront MCP, and the CLI give equivalent outcomes over the same contract. MCP needs no shell. It imports public media by URL and returns one-use authenticated artifact links. Local file reads and direct saves are optional host capabilities, not missing commerce features.

The CLI caches the contract locally for 30 minutes, so one workflow does not download and index hundreds of operations repeatedly. The server still re-authorizes the live credential, grant, permission, revision, and risk ceiling on every request. `operations describe` flattens only top-level input fields. `--full` returns the exact nested request schema and the responses.

Skill metadata routes a request to one focused skill. The setup/router skill is not loaded for routine domain work. Every focused skill starts with a projected read or workflow resolution and treats the returned operation IDs and live schemas as authority. `media upload` takes 1 to 50 files. It checks signature, extension, and size, reuses one live contract in-process, runs the resumable initiate, part, and complete sequence, aborts an incomplete session on failure, and returns the committed media IDs. Images (JPEG, PNG, GIF, WebP, AVIF) are limited to 20 MiB. Video (MP4, WebM) is limited to 100 MiB. No server renders images: for JPEG, PNG, WebP and AVIF the CLI also encodes the WebP rendition ladder on your machine (with the optional `sharp` dependency, the same widths and quality as the dashboard) and saves it after the upload completes; each result reports `renditions` as `saved`, `pending` or `none`. If `sharp` is not installed on your platform or an image cannot be encoded, the upload still succeeds and the image stays `pending`: shoppers get the original until an open dashboard renders it.

`operations run` input has three fields: `path`, `query`, and `body`. The CLI measures a JSON body as serialized UTF-8 and rejects it when it exceeds the operation's reviewed request limit. The same check applies to each batch step. Multipart operations take repeatable `--file field=@path` arguments for the binary fields that OpenAPI declares. A raw upload operation takes exactly one `--file path`. The CLI streams it as `application/octet-stream` with an exact `Content-Length` and enforces the schema and operation byte bounds. Raw file input never reads stdin and never runs in a batch. `--save path` works only for an operation that declares artifact output, and that operation requires it. The CLI checks the media type, disposition, filename, declared length, and actual byte count before it atomically publishes the file. `--overwrite` replaces an existing destination. An operation with `write`, `destructive`, `financial`, or `security` risk requires `--yes`. An operation that requires idempotency also requires `--idempotency-key`.

An agent without a shell or local files can use `dashboard.media.import_url` through MCP or the CLI. It commits a credential-free public HTTPS image or video. It validates redirects, Content-Type, exact length, signature, and the same media limits as a local upload. Its images stay pending until an open dashboard tab renders their WebP renditions in the background. A capable MCP client can use the reviewed direct-upload action instead, without sending base64 media through the model context.

A hosted continuation opens a one-time page that the CLI serves from `127.0.0.1` on a random port and path. The page opens the continuation's HTTPS target and passes the one-time fields to it with `postMessage`. The fields never appear in a URL, a command argument, stdout, stderr, the OpenAPI cache, or the credentials file. Device operations and excluded operations are not available through `operations run`.

`--output json` writes one compact JSON document to stdout. A JSON error is one document on stderr. Diagnostics and progress also use stderr. Exit codes are `0` success, `2` usage error or missing `--yes`, `3` authentication, `4` authorization, `5` validation, `6` conflict, `7` temporary failure, `8` server or contract failure, and `130` interruption.

Run `scalius --help` for the complete command reference.
