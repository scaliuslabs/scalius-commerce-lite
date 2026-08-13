# Scalius CLI

`scalius` discovers and invokes the stable operations published by any Scalius Commerce store. It never accepts arbitrary routes, methods, request headers, or database commands.

The CLI derives its operation catalog, schemas, permissions, risk, revisions, idempotency, byte limits, artifacts, uploads, and secure browser continuations from the store's live OpenAPI contract. New reviewed store capabilities become discoverable without publishing a second hard-coded command catalog.

Requires Node.js 22.12 or newer.

```sh
npm install --global scalius

scalius auth login --server https://api.example.com
scalius auth login --server https://api.example.com --resource storefront --profile-name my-store-storefront
scalius operations search products
scalius operations describe dashboard.products.create
scalius operations run dashboard.products.create --input @product.json --yes
scalius media upload hero.jpg orange.jpg blue.jpg --yes
scalius setup --harness codex --server https://api.example.com
```

You can also try it without a global install:

```sh
npx scalius --help
```

For CI, configure `SCALIUS_SERVER` and `SCALIUS_TOKEN`. The environment credential is not written to disk. Interactive and imported credentials are stored under the platform config directory with `0700` directory and `0600` file permissions.

## Commands

```text
scalius auth login --server <api-origin> [--resource dashboard|storefront] [--profile-name <name>]
scalius auth token import --server <api-origin>
scalius auth status
scalius auth logout
scalius auth revoke
scalius profile list
scalius profile use <name>
scalius profile show [name]
scalius operations search [query] [--limit <1-100>]
scalius operations describe <operationId> [--full]
scalius operations run <operationId> --input <json|@file|->
scalius operations batch --input <json|@file|->
scalius media upload <files...> --yes
scalius setup --harness <agents|codex|claude|opencode|pi> [--server <origin>] [--force]
scalius skill install [--harness <name>] [--force]
```

Run `scalius setup` before operating a store. The bundled `scalius-commerce` skill follows the open Agent Skills format and installs to the native user location for Codex, Claude Code, OpenCode, Pi, or the cross-client `.agents/skills` convention. Setup prints exact credential-free instructions for both audience-specific MCP servers; it never writes tokens into harness configuration. Pi supports the skill and full CLI natively; because Pi's core has no MCP client, setup prints the separately installed `pi-mcp-adapter` package from Pi's catalog and shared MCP configuration but never silently installs executable third-party code.

The workflow is deliberately harness-neutral: search, compactly describe one
operation, request `--full` only while building its input, execute, and verify
with a bounded read. The live finalized OpenAPI contract—not a model-specific
prompt—is authoritative for fields, RBAC, risk, revisions, idempotency, byte
limits, artifacts, uploads, and continuations.

The CLI keeps a reviewed contract locally for 30 minutes so one complex workflow
does not repeatedly download and re-index hundreds of operations. The server
still re-authorizes the live credential, grant, permission, revision, and risk
ceiling on every request. Default descriptions flatten only top-level input
fields; `operations describe <id> --full` returns the exact nested construction
schema and responses.

The skill teaches one compact discovery and safety loop, then loads only the relevant domain guide. `media upload` validates signatures, extensions, and byte limits, reuses one live contract in-process, performs the resumable initiate/part/complete sequence, aborts an incomplete session on failure, and returns committed media IDs. Supported images are JPEG, PNG, GIF, WebP, and AVIF up to 20 MiB; supported video is MP4 and WebM up to 100 MiB.

`operations run` input has three fields: `path`, `query`, and `body`. JSON bodies are measured after serialization as UTF-8 and rejected locally when they exceed the live operation's reviewed request limit; the same check applies to each resolved batch step. Multipart operations accept repeatable `--file field=@path` arguments for binary fields declared by OpenAPI. Reviewed raw upload operations accept exactly one `--file path`; the CLI streams it as `application/octet-stream` with an exact `Content-Length` and enforces matching live schema and operation byte bounds. Raw file input never accepts stdin and never runs in a batch. `--save path` is enabled only for contract-declared artifact output; those downloads enforce the reviewed media type, disposition, filename, declared length, and actual byte limit before atomically publishing the destination. Mutating operations require `--yes`; operations marked as requiring idempotency also require `--idempotency-key`.

For agents without shell or local-file access, `dashboard.media.import_url` commits a credential-free public HTTPS image or video through either MCP or CLI. It validates redirects, Content-Type, exact length, signature, and the same media limits as local upload. MCP cannot portably read a host's private files; capable clients use the reviewed direct-upload action instead, without sending base64 media through model context.

Reviewed hosted continuations open a fixed same-origin browser relay and keep one-time fields in ephemeral memory. They are never placed in a URL, command argument, stdout, stderr, the OpenAPI cache, or the credentials file. Device operations and concrete exclusions remain intentionally unavailable through generic `operations run`.

`--output json` writes one JSON document to stdout. Diagnostics and progress use stderr. Exit codes are `0` success, `2` usage or local confirmation, `3` authentication, `4` authorization, `5` validation, `6` conflict, `7` temporary failure, `8` server or contract failure, and `130` interruption.

Run `scalius --help` for the complete command reference.
