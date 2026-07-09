import type { AdminAgentRuntimeEnv } from "../../runtime-env";

export type Env = Readonly<AdminAgentRuntimeEnv>;

export type JsonRecord = Record<string, unknown>;

export interface AdminPermissionsSuccess {
  ok: true;
  body: JsonRecord;
}

export interface AdminPermissionsFailure {
  ok: false;
  status: number;
  code: string;
}

export type AdminPermissionsResult = AdminPermissionsSuccess | AdminPermissionsFailure;

export interface AdminMcpOptions {
  cookie?: string | null;
  userAgent?: string | null;
  permissionsBody?: JsonRecord;
}

export interface AdminMcpAuthContext {
  cookie: string;
  userAgent: string | null;
  permissionsBody: JsonRecord;
}
