// Copy to apps/admin-v2/vite.agent.config.ts in YOUR worktree (never commit it;
// delete it before your final report). Run from apps/admin-v2:
//   AGENT_PORT=4331 pnpm exec vite --config vite.agent.config.ts
// The shared local API (http://localhost:8787, run by the lead from the main
// checkout) only accepts dashboard writes whose Origin is the local Dashboard
// URL, so this dev-only proxy presents that origin.
import { mergeConfig } from "vite";
import base from "./vite.config";

const origin = { origin: "http://localhost:4323" };
export default mergeConfig(base, {
  server: {
    port: Number(process.env.AGENT_PORT ?? 4331),
    strictPort: true,
    proxy: {
      "/api/v1": { headers: origin },
      "/api/auth": { headers: origin },
      "/api/scanner-token": { headers: origin },
    },
  },
});
