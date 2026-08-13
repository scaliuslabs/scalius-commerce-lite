# Harness setup

Install or refresh this exact bundled skill and print the two audience-specific MCP instructions:

```sh
scalius setup --harness <agents|codex|claude|opencode|pi> --server https://api.example.com
```

`agents` installs the cross-client Agent Skills convention. The named harnesses install their native user-level skill path. Codex, Claude Code, and OpenCode receive exact remote-MCP install and OAuth login commands. Pi receives the skill and can use the full CLI immediately; its core agent has no native MCP client, so setup prints the `pi-mcp-adapter` package listed in Pi's catalog, exact shared config, and `/mcp-auth` commands. It never silently installs third-party executable code; review that package before opting in.

Dashboard and storefront are separate OAuth audiences. Install and authenticate both. Never copy an OAuth access token, PAT, continuation code, OTP, receipt proof, or payment secret into MCP configuration. After setup, restart or reload the harness if it does not live-discover the skill, then search and describe a harmless read through each server before mutating anything.
