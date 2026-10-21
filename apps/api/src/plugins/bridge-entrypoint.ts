// `PluginBridge`: the bridge as a WorkerEntrypoint, re-exported by the Worker
// entry (src/worker.ts) so the sandbox loader can bind it through
// `ctx.exports.PluginBridge({ props })`. Props are set by the host per
// invocation; a sandboxed plugin holds only the resulting stub. The methods
// delegate to the same `PluginBridgeHost` the bundled loader calls
// in-process. Lazily loaded: importing this module loads no host code.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { PluginApiResult, PluginObjectQuery } from "@scalius/plugin-sdk";
import type { ObjectRecordVersion, ObjectOperation, ObjectQueryResult } from "@scalius/core/modules/objects";
import type { PluginCustomerRoleGrant } from "@scalius/shared/plugins/customer-roles";
import type { PluginJob } from "@scalius/shared/plugins/jobs";
import type {
  PluginBridgeApi,
  PluginBridgeEnvironment,
  PluginBridgeProps,
  PluginHttpInit,
  PluginHttpResult,
  PluginKvSetOptions,
} from "./bridge";

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

function requireProps(props: unknown): PluginBridgeProps {
  const candidate = props as Partial<PluginBridgeProps> | undefined;
  if (
    !candidate ||
    typeof candidate.pluginId !== "string" ||
    !PLUGIN_ID.test(candidate.pluginId) ||
    typeof candidate.version !== "string" ||
    typeof candidate.authority !== "object" ||
    candidate.authority === null
  ) {
    throw new Error("[internal_error] The plugin bridge was bound without an installation.");
  }
  return candidate as PluginBridgeProps;
}

/** The bridge's database and env for one invocation (the request's own bindings). */
async function workerEnvironment(env: Env, ctx: ExecutionContext): Promise<PluginBridgeEnvironment> {
  const { getDb } = await import("@scalius/database/client");
  let composed: Promise<Env> | null = null;
  const db = getDb(env);
  return {
    env,
    ctx,
    db: () => db,
    composedEnv: () => {
      composed ??= import("../runtime/runtime-env").then(({ composeApiRuntimeEnv }) => composeApiRuntimeEnv(env));
      return composed;
    },
  };
}

/**
 * Only the capability methods below are RPC-callable. Everything else lives in
 * instance fields or `#private` members, which Workers RPC never exposes: a
 * plugin holding the stub cannot reach the env, the database or the props.
 */
export class PluginBridge extends WorkerEntrypoint<Env, PluginBridgeProps> implements PluginBridgeApi {
  #hostInstance: Promise<PluginBridgeApi> | null = null;

  /** An instance field, not a method, so it is never RPC-callable; the sandbox test harness replaces it. */
  protected readonly environment: () => Promise<PluginBridgeEnvironment> = () => workerEnvironment(this.env, this.ctx);

  #host(): Promise<PluginBridgeApi> {
    this.#hostInstance ??= (async () => {
      const props = requireProps(this.ctx.props);
      const [{ PluginBridgeHost }, environment] = await Promise.all([import("./bridge"), this.environment()]);
      return new PluginBridgeHost(props, environment);
    })();
    return this.#hostInstance;
  }

  async apiCall(operationId: string, input?: unknown): Promise<PluginApiResult> {
    return (await this.#host()).apiCall(operationId, input);
  }

  async objectsGet(object: string, id: string): Promise<ObjectRecordVersion | null> {
    return (await this.#host()).objectsGet(object, id);
  }

  async objectsGetByHandle(object: string, handle: string): Promise<(ObjectRecordVersion & { id: string }) | null> {
    return (await this.#host()).objectsGetByHandle(object, handle);
  }

  async objectsWrite(operations: ObjectOperation[]): Promise<Array<number | null>> {
    return (await this.#host()).objectsWrite(operations);
  }

  async objectsQuery(object: string, query?: PluginObjectQuery): Promise<ObjectQueryResult> {
    return (await this.#host()).objectsQuery(object, query);
  }

  async objectsCount(object: string, where?: PluginObjectQuery["where"]): Promise<number> {
    return (await this.#host()).objectsCount(object, where);
  }

  async kvGet(key: string): Promise<{ value: unknown; revision: number } | null> {
    return (await this.#host()).kvGet(key);
  }

  async kvSet(key: string, value: unknown, options?: PluginKvSetOptions): Promise<{ revision: number }> {
    return (await this.#host()).kvSet(key, value, options);
  }

  async kvDelete(key: string): Promise<void> {
    return (await this.#host()).kvDelete(key);
  }

  async kvList(prefix?: string): Promise<string[]> {
    return (await this.#host()).kvList(prefix);
  }

  async httpFetch(url: string, init?: PluginHttpInit): Promise<PluginHttpResult> {
    return (await this.#host()).httpFetch(url, init);
  }

  async customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>> {
    return (await this.#host()).customFieldsGet(ownerType, ownerId);
  }

  async customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void> {
    return (await this.#host()).customFieldsSet(ownerType, ownerId, values);
  }

  async messagingEmail(input: Parameters<PluginBridgeApi["messagingEmail"]>[0]): Promise<{ queued: boolean; duplicate?: boolean }> {
    return (await this.#host()).messagingEmail(input);
  }

  async messagingSms(input: Parameters<PluginBridgeApi["messagingSms"]>[0]): Promise<{ queued: boolean }> {
    return (await this.#host()).messagingSms(input);
  }

  async messagingNotifyStaff(input: Parameters<PluginBridgeApi["messagingNotifyStaff"]>[0]): Promise<void> {
    return (await this.#host()).messagingNotifyStaff(input);
  }

  async messagingPush(input: Parameters<PluginBridgeApi["messagingPush"]>[0]): Promise<{ delivered: boolean }> {
    return (await this.#host()).messagingPush(input);
  }

  async timelineAdd(input: Parameters<PluginBridgeApi["timelineAdd"]>[0]): Promise<{ id: string }> {
    return (await this.#host()).timelineAdd(input);
  }

  async ordersHold(input: Parameters<PluginBridgeApi["ordersHold"]>[0]): Promise<void> {
    return (await this.#host()).ordersHold(input);
  }

  async ordersRelease(input: Parameters<PluginBridgeApi["ordersRelease"]>[0]): Promise<{ revision: number; replayed: boolean }> {
    return (await this.#host()).ordersRelease(input);
  }

  async ordersAssessRisk(input: Parameters<PluginBridgeApi["ordersAssessRisk"]>[0]): Promise<void> {
    return (await this.#host()).ordersAssessRisk(input);
  }

  async ordersRiskHistory(orderId: string): Promise<{ orders: number; cancelled: number; returnedToSender: number }> {
    return (await this.#host()).ordersRiskHistory(orderId);
  }

  async customerRolesGrant(customerId: string, role: string, ref?: string | null): Promise<void> {
    return (await this.#host()).customerRolesGrant(customerId, role, ref);
  }

  async customerRolesRevoke(customerId: string, role: string): Promise<void> {
    return (await this.#host()).customerRolesRevoke(customerId, role);
  }

  async customerRolesList(customerId: string): Promise<PluginCustomerRoleGrant[]> {
    return (await this.#host()).customerRolesList(customerId);
  }

  async jobsStart(name: string, options?: { input?: unknown; key?: string }): Promise<{ id: string; status: PluginJob["status"] }> {
    return (await this.#host()).jobsStart(name, options);
  }

  async jobsGet(id: string): Promise<PluginJob | null> {
    return (await this.#host()).jobsGet(id);
  }

  async jobsList(options?: { name?: string; limit?: number }): Promise<PluginJob[]> {
    return (await this.#host()).jobsList(options);
  }

  async jobsCancel(id: string): Promise<PluginJob> {
    return (await this.#host()).jobsCancel(id);
  }
}
