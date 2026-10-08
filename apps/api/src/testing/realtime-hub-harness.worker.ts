// Test-only Worker for realtime-hub.workerd.test.ts: the real RealtimeHub in
// workerd, with a front door that stands in for realtime/connect.ts (the
// test passes the identity the API Worker would have proven).
import { REALTIME_IDENTITY_HEADER } from "../realtime/hub";
import type { RealtimeChange } from "@scalius/shared/realtime";

export { RealtimeHub } from "../realtime/hub";

interface HarnessEnv {
  REALTIME_HUB: DurableObjectNamespace<import("../realtime/hub").RealtimeHub>;
}

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    const url = new URL(request.url);
    const hub = env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName("store"));
    if (url.pathname === "/connect") {
      const headers = new Headers({ Upgrade: "websocket" });
      headers.set(REALTIME_IDENTITY_HEADER, url.searchParams.get("identity") ?? "");
      return hub.fetch(new Request("https://realtime-hub.internal/connect", { headers }));
    }
    if (url.pathname === "/publish") {
      return Response.json(await hub.publish(await request.json() as RealtimeChange[]));
    }
    if (url.pathname === "/online") {
      return Response.json(await hub.online());
    }
    return new Response("Not Found", { status: 404 });
  },
};
