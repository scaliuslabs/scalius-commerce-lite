/**
 * First-admin setup token contract.
 *
 * When the Platform setting `setupTokenRequired` is on, `POST /api/v1/setup`
 * accepts a request only when this header equals the HKDF-derived
 * `ADMIN_SETUP_TOKEN` (purpose label `admin-setup`). Automation derives the
 * same value from `SCALIUS_SECRET` with `scripts/derive-runtime-secret.mjs`.
 * The token is never logged, echoed, or stored.
 */
export const ADMIN_SETUP_TOKEN_HEADER = "X-Scalius-Setup-Token";
