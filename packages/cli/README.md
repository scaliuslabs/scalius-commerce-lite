# Scalius CLI

`scalius` discovers and invokes the stable operations published by any Scalius Commerce store. It never accepts arbitrary routes, methods, request headers, or database commands.

The CLI derives its operation catalog, schemas, permissions, risk, revisions, idempotency, byte limits, artifacts, uploads, and secure browser continuations from the store's live OpenAPI contract. New reviewed store capabilities become discoverable without publishing a second hard-coded command catalog.

Requires Node.js 22.12 or newer.

```sh
npm install --global scalius

scalius auth login --server https://api.example.com
scalius operations search products
scalius operations describe dashboard.products.create
scalius operations run dashboard.products.create --input @product.json --yes
```

You can also try it without a global install:

```sh
npx scalius --help
```

For CI, configure `SCALIUS_SERVER` and `SCALIUS_TOKEN`. The environment credential is not written to disk. Interactive and imported credentials are stored under the platform config directory with `0700` directory and `0600` file permissions.

## Commands

```text
scalius auth login --server <api-origin>
scalius auth token import --server <api-origin>
scalius auth status
scalius auth logout
scalius auth revoke
scalius profile list
scalius profile use <name>
scalius profile show [name]
scalius operations search [query]
scalius operations describe <operationId>
scalius operations run <operationId> --input <json|@file|->
scalius operations batch --input <json|@file|->
```

`operations run` input has three fields: `path`, `query`, and `body`. JSON bodies are measured after serialization as UTF-8 and rejected locally when they exceed the live operation's reviewed request limit; the same check applies to each resolved batch step. Multipart operations accept repeatable `--file field=@path` arguments for binary fields declared by OpenAPI. Reviewed raw upload operations accept exactly one `--file path`; the CLI streams it as `application/octet-stream` with an exact `Content-Length` and enforces matching live schema and operation byte bounds. Raw file input never accepts stdin and never runs in a batch. `--save path` is enabled only for contract-declared artifact output; those downloads enforce the reviewed media type, disposition, filename, declared length, and actual byte limit before atomically publishing the destination. Mutating operations require `--yes`; operations marked as requiring idempotency also require `--idempotency-key`.

Reviewed hosted continuations open a fixed same-origin browser relay and keep one-time fields in ephemeral memory. They are never placed in a URL, command argument, stdout, stderr, the OpenAPI cache, or the credentials file. Device operations and concrete exclusions remain intentionally unavailable through generic `operations run`.

`--output json` writes one JSON document to stdout. Diagnostics and progress use stderr. Exit codes are `0` success, `2` usage or local confirmation, `3` authentication, `4` authorization, `5` validation, `6` conflict, `7` temporary failure, `8` server or contract failure, and `130` interruption.

Run `scalius --help` for the complete command reference.
