# Setup

## One command

```sh
npx scalius@latest init --server https://api.yourstore.com
```

Use the store API address from Settings > Store details > Web addresses. `init`:

1. Pairs the CLI with the store: it opens `/connect` in the browser, the merchant approves the code once, and the credential is saved in the Scalius config directory (`0600`). This is the only login: the agent's MCP server reuses it.
2. Finds the agents on the machine and connects each:
   - Claude Code: a `scalius` plugin in `~/.claude/skills/scalius` (skills plus MCP server, loaded as `scalius@skills-dir`); older Claude Code gets the skills plus `claude mcp add`.
   - Codex: the `scalius@scalius-local` plugin (`codex plugin add`), or skills plus `codex mcp add`.
   - Cursor: skills in `~/.cursor/skills` and the server in `~/.cursor/mcp.json`.
   - OpenCode: skills and an `mcp` entry in `~/.config/opencode/opencode.json`.
   - Pi and any other Agent Skills client: skills only; init prints the MCP entry to add.
3. Runs `scalius doctor`.

The MCP server is local: the agent starts `scalius mcp`, which forwards every MCP message to `https://<store-api>/api/v1/mcp/dashboard` with the paired credential. The credential never enters the agent's configuration.

Options: `--harness claude,codex` (default `auto`), `--storefront` (also connect buyer tools; a second approval), `--no-open` (print the link instead of opening a browser, for a remote shell), `--no-auth` (install only), `--profile-name <name>`.

Run `init` again to update skills and registrations after upgrading; it replaces its own entries and never adds a second server.

## Doctor

`scalius doctor` checks, in order: Node version, profile, the store's agent metadata, the credential and its expiry, the MCP tools, the store context, and each agent's skills and server. Each failing line prints its fix.

## Audiences

- Dashboard (default): the merchant's tools.
- Storefront (`--storefront`): buyer tools for testing carts and checkout; public buyer agents use UCP instead.

A credential belongs to one audience and one store. Several stores: one profile each (`scalius --profile <name> ...`, `scalius profile use <name>`).

## CI and servers

Set `SCALIUS_SERVER` and `SCALIUS_TOKEN` (a personal access token from Settings > Agent access); nothing is written to disk. Output is JSON when stdout is not a terminal.

## Without a local CLI

A remote-only client can add `https://<store-api>/api/v1/mcp/dashboard` as a Streamable HTTP MCP server and sign in with OAuth there. That is a separate login from the CLI.

## Never

Never paste tokens, OTPs, receipt proofs, payment secrets or continuation fields into chat, URLs, config files or logs.
