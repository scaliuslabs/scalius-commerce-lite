export interface LoadTimingSample {
    serviceMs: number;
    scheduledMs: number;
    startLagMs: number;
}
export interface LoadTimingSummary {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}
export interface OpenArrivalResult<T> {
    value: T;
    timing: LoadTimingSample;
}
export interface OpenArrivalOptions<T> {
    count: number;
    ratePerSecond: number;
    execute: (sequence: number) => Promise<T>;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    leadInMs?: number;
}
export declare const LOADTEST_TARGET_PURPOSE: "scalius-checkout-loadtest/v1";
export interface LoadTargetIdentity {
    targetId: string;
    databaseHostname: string;
    fixtureNamespace: string;
}
export interface LoadTargetAcknowledgementInput {
    databaseUrl: string;
    acknowledgedDatabaseHostname: string;
    expectedTargetId: string;
    acknowledgedTargetId: string;
}
export interface TursoLoadBillingIsolationInput {
    loadOrganization: string;
    acknowledgedLoadOrganization: string;
    productionOrganization: string;
    acknowledgedProductionOrganization: string;
}
export interface TursoLoadBillingIsolation {
    loadOrganization: string;
    productionOrganization: string | null;
}
export declare function readCheckoutQuoteFingerprint(response: Record<string, unknown> | null): string;
export declare function describeLoadTransportError(error: unknown): string;
interface LoadTargetSentinelInput extends LoadTargetAcknowledgementInput {
    sentinelRows: readonly Record<string, unknown>[];
}
/**
 * A disposable database or group does not isolate Turso's organization-wide
 * row quotas. Live capacity tests must therefore use a billing organization
 * that is distinct from the organization serving production databases.
 */
export declare function assertTursoLoadBillingIsolation(input: TursoLoadBillingIsolationInput): TursoLoadBillingIsolation;
export declare function assertDisposableLoadTarget(apiUrl: string, acknowledgedHostname: string): URL;
export declare function assertDisposableDatabaseProvisionTarget(input: LoadTargetAcknowledgementInput): LoadTargetIdentity;
export declare function assertDisposableDatabaseTarget(input: LoadTargetSentinelInput): LoadTargetIdentity;
export declare function percentile(values: readonly number[], fraction: number): number;
export declare function summarizeTimings(samples: readonly LoadTimingSample[], field: keyof LoadTimingSample): LoadTimingSummary;
export declare function runOpenArrival<T>(options: OpenArrivalOptions<T>): Promise<readonly OpenArrivalResult<T>[]>;
export {};
//# sourceMappingURL=live-checkout-load-core.d.ts.map