// The stored states of an agent connection and of a CLI pairing, and the only
// moves between them. Every writer's update names its move's source states.
import { defineMachine } from "@scalius/shared/machine";

/** `agent_grants.status`. Expiry is read from `expires_at`, never written. */
export const GRANT_MACHINE = defineMachine({
  name: "agent connection",
  states: ["active", "revoked"],
  initial: ["active"],
  final: ["revoked"],
  moves: {
    revoke: { from: ["active"], to: "revoked" },
  },
});

/** `agent_device_authorizations.status`: a CLI pairing, from the tool's start to its end. */
export const PAIRING_MACHINE = defineMachine({
  name: "CLI pairing",
  states: ["pending", "approved", "consumed", "denied", "expired"],
  initial: ["pending"],
  final: ["consumed", "denied", "expired"],
  moves: {
    approve: { from: ["pending"], to: "approved" },
    deny: { from: ["pending"], to: "denied" },
    // The tool stored its credential: the pairing is a connection now.
    acknowledge: { from: ["approved"], to: "consumed" },
    // Nobody answered in time, or the tool never collected what was approved.
    expire: { from: ["pending", "approved"], to: "expired" },
  },
});
