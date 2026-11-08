// Payouts domain: the record of money an app sends to a payee through a
// payout provider (the `payout` port), committed before the provider call,
// one per app and Idempotency-Key, moving forward only. A LEAF domain: it
// imports only @scalius/database, @scalius/shared and core errors, never
// another domain. The provider call itself lives in the API
// (apps/api/src/plugins/providers/payout.ts), which owns the plugin host.
export {
    PAYOUT_LIST_MAX,
    PAYOUT_REQUEST_MISMATCH_CODE,
    applyPayoutAnswer,
    applyPayoutCallback,
    findPayoutByKey,
    getAppPayout,
    listAppPayouts,
    newPayoutId,
    payoutFailureCode,
    payoutFailureMessage,
    payoutRepresentation,
    payoutRequestDigest,
    readPayoutRepresentation,
    recordPayout,
    type Payout,
    type PayoutAnswer,
    type PayoutCallbackUpdate,
    type PayoutRequest,
    type PayoutStatus,
} from "./payouts";
