// src/worker.ts
import { handle } from '@astrojs/cloudflare/handler';
import { handleQueueBatch } from './queue-consumer';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Astro's internal handler takes over HTTP requests
    return handle(request, env, ctx);
  },
  
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext) {
    // Route queue messages to your existing consumer
    return handleQueueBatch(batch, env);
  }
};
