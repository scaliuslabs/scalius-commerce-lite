// apps/storefront/src/worker.ts
import { handle } from '@astrojs/cloudflare/handler';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(request, env, ctx);
  }
};
