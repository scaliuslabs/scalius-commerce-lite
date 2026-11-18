import { inArray } from "drizzle-orm";
import { adminInvitations } from "@scalius/database/schema";
import { defineMachine } from "@scalius/shared/machine";

/** `admin_invitations.status`: an administrator invitation is answered once. */
export const INVITATION_MACHINE = defineMachine({
  name: "administrator invitation",
  states: ["pending", "accepted", "revoked"],
  initial: ["pending"],
  final: ["accepted", "revoked"],
  moves: {
    // The invitee set their first password.
    accept: { from: ["pending"], to: "accepted" },
    // Cancelled before it was accepted, or its invitee removed from staff.
    revoke: { from: ["pending"], to: "revoked" },
  },
});

/** An invitation whose state allows `move`: every writer's update names the move's source states. */
export function invitationCan(move: keyof typeof INVITATION_MACHINE.moves) {
  return inArray(adminInvitations.status, [...INVITATION_MACHINE.moves[move].from]);
}
