import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAdminCommerceTools } from "./commerce-tools";
import { registerAdminContentTools } from "./content-tools";
import { registerAdminDashboardTool } from "./dashboard-tool";
import { registerAdminMediaInventoryTools } from "./media-inventory-tools";
import { registerAdminContextTools } from "./navigation";
import { registerAdminProductTools } from "./product-tools";
import { registerAdminSettingsTools } from "./settings-tools";
import type { AdminMcpOptions, Env } from "./types";

export function createAdminMcpServer(
  env: Env,
  options: AdminMcpOptions = {},
): McpServer {
  const server = new McpServer({
    name: env.AGENT_NAME?.trim() || "scalius-admin-agent",
    version: env.AGENT_VERSION?.trim() || "0.1.0",
  });

  registerAdminContextTools(server, env, options);
  registerAdminProductTools(server, env, options);
  registerAdminContentTools(server, env, options);
  registerAdminCommerceTools(server, env, options);
  registerAdminMediaInventoryTools(server, env, options);
  registerAdminDashboardTool(server, env, options);
  registerAdminSettingsTools(server, env, options);

  return server;
}
