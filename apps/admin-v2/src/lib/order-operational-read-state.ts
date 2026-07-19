export type OrderOperationalReadStatus =
  | "loading"
  | "ready"
  | "unavailable"
  | "stale";

export interface OrderOperationalReadState {
  status: OrderOperationalReadStatus;
  refreshing: boolean;
}

export function resolveOrderOperationalReadState(input: {
  hydrated: boolean;
  loading: boolean;
  error: boolean;
  fetching: boolean;
  hasData: boolean;
}): OrderOperationalReadState {
  if (!input.hydrated || input.loading) {
    return { status: "loading", refreshing: false };
  }

  if (input.error) {
    return {
      status: input.hasData ? "stale" : "unavailable",
      refreshing: input.fetching,
    };
  }

  return { status: "ready", refreshing: input.fetching };
}
