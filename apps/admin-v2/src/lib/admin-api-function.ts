type MaybePromise<T> = T | Promise<T>;

export type AdminApiFunction<TInput, TResult> = (
  options: { data: TInput },
) => Promise<TResult>;

interface ValidatedAdminApiFunctionBuilder<TInput, TValidated> {
  handler<TResult>(
    handler: (context: { data: TValidated }) => MaybePromise<TResult>,
  ): AdminApiFunction<TInput, TResult>;
}

interface AdminApiFunctionBuilder {
  validator<TInput, TValidated>(
    validator: (data: TInput) => TValidated,
  ): ValidatedAdminApiFunctionBuilder<TInput, TValidated>;
  handler<TResult>(
    handler: (context: { data: void }) => MaybePromise<TResult>,
  ): () => Promise<TResult>;
}

/**
 * Compatibility-shaped builder for ordinary admin HTTP operations.
 *
 * It deliberately mirrors the small `validator().handler()` surface used by
 * the old TanStack server functions so domains can migrate mechanically while
 * calls execute through the isomorphic admin HTTP client instead of another
 * RPC endpoint.
 */
export function createAdminApiFunction(
  _options?: { method?: "GET" | "POST" },
): AdminApiFunctionBuilder {
  return {
    validator<TInput, TValidated>(validator: (data: TInput) => TValidated) {
      return {
        handler<TResult>(
          handler: (context: { data: TValidated }) => MaybePromise<TResult>,
        ): AdminApiFunction<TInput, TResult> {
          return async ({ data }) => handler({ data: validator(data) });
        },
      };
    },
    handler<TResult>(
      handler: (context: { data: void }) => MaybePromise<TResult>,
    ): () => Promise<TResult> {
      return async () => handler({ data: undefined });
    },
  };
}
