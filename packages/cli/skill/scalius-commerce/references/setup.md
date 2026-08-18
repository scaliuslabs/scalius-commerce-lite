# Harness setup

Install or refresh the complete bundled skill suite and print both audience-specific MCP instructions:

```sh
scalius setup --harness <agents|codex|claude|opencode|pi> --server https://api.example.com
```

Use `--force` only to replace an existing Scalius suite with the bundled version. `agents` uses the cross-client Agent Skills convention; named harnesses use their native user skill directory. Codex, Claude Code, and OpenCode receive exact remote-MCP install and OAuth commands. Pi can use the CLI natively; its core has no MCP client, so setup only prints the separately reviewed `pi-mcp-adapter` option and never installs it silently.

Authenticate dashboard and storefront separately. Pair CLI profiles with `scalius auth login --resource dashboard` and `--resource storefront --profile-name <name>`. Never copy OAuth tokens, PATs, OTPs, receipt proofs, payment secrets, or continuation fields into configuration, prompts, URLs, or logs.

After installation, reload the harness if skills are not discovered. Test one harmless data question with `workflows.read`; an unavailable result is normal and should fall back to `workflows.resolve`. Test each MCP audience separately. The CLI and MCP consume the same live contract; local file streaming and direct artifact saves are optional host capabilities, not different commerce authority.
