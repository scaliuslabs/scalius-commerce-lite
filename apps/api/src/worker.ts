// apps/api/src/worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { handleQueueBatch } from "./queue-consumer";

export type { AppType } from "./app";

export default class ApiWorker extends WorkerEntrypoint<Env> {
  // HTTP: Hono handles all requests
  async fetch(request: Request) {
    return app.fetch(request, this.env, this.ctx);
  }

  // Queues: payment events, order ingest, OTP, notifications
  async queue(batch: MessageBatch) {
    return handleQueueBatch(batch, this.env);
  }
}
