# Harness setup

Install or refresh this exact bundled skill and print the two audience-specific MCP instructions:

```sh
scalius setup --harness <agents|codex|claude|opencode|pi> --server https://api.example.com
```

`agents` installs the cross-client Agent Skills convention. The named harnesses install their native user-level skill path. Codex, Claude, and OpenCode receive exact remote-MCP install and OAuth login commands. Pi receives the skill and can use the full CLI immediately; its core agent has no native MCP client, so setup prints the `pi-mcp-adapter` package listed in Pi's catalog, exact shared config, and `/mcp-auth` commands. It never silently installs third-party executable code; review that package before opting in.

Dashboard and storefront are separate OAuth audiences. Install and authenticate both. Never copy an OAuth access token, PAT, continuation code, OTP, receipt proof, or payment secret into MCP configuration. After setup, restart or reload the harness if it does not live-discover the skill, then search and describe a harmless read through each server before mutating anything.

CLI credentials are audience-scoped too. Pair a normal merchant-operations profile with `scalius auth login --server <api-origin> --resource dashboard`, and pair a separate buyer-workflow profile with `--resource storefront --profile-name <store>-storefront`. The browser approval page shows the requested audience before the Super Admin approves it. Use `--profile <name>` to select the intended connection; one credential never silently crosses audiences.

The operating model is identical in every harness: search, compactly describe
one operation, request the full schema only while constructing its input,
execute, then verify through a bounded read. Do not look for harness-specific
commerce tools or load the complete OpenAPI document into model context. MCP
and CLI both consume the same live finalized contract and must provide the same
merchant outcomes. MCP uses public-URL media import and one-use authenticated
artifact links when its host has no local filesystem. A capable local host may
additionally stream private files or save an artifact directly; that host
capability must never turn the CLI into a prerequisite for commerce.
