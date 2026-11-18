import { defineMachine } from "@scalius/shared/machine";

/**
 * A multipart upload into the Files library. The database check
 * `media_upload_handle_valid` keeps a session without a storage upload handle
 * in `initializing` or `failed`, so `failed` is where abort and expiry end a
 * session that never got one: nothing was stored, so nothing is left to abort.
 */
export const MEDIA_UPLOAD_MACHINE = defineMachine({
    name: "media upload",
    states: ["initializing", "initiated", "uploading", "completing", "committed", "aborting", "aborted", "expired", "failed"],
    initial: ["initializing"],
    final: ["committed", "aborted", "expired", "failed"],
    moves: {
        initiate: { from: ["initializing"], to: "initiated" },
        fail: { from: ["initializing"], to: "failed" },
        receive_part: { from: ["initiated", "uploading"], to: "uploading" },
        complete: { from: ["initiated", "uploading"], to: "completing" },
        commit: { from: ["completing"], to: "committed" },
        // Claimed before the storage abort, so a crash between the two is finished by the next abort or expiry.
        stop: { from: ["initiated", "uploading"], to: "aborting" },
        abort: { from: ["aborting"], to: "aborted" },
        expire: { from: ["aborting"], to: "expired" },
        // A completion the client left that still cannot finish once the session has expired.
        abandon: { from: ["completing"], to: "expired" },
    },
});

export type MediaUploadMove = keyof typeof MEDIA_UPLOAD_MACHINE.moves;

/** The states expiry ends. `completing` is finished (or abandoned) by the sweep instead: completion may be retried. */
export const MEDIA_UPLOAD_EXPIRABLE_STATES = ["initializing", "initiated", "uploading", "aborting"] as const;

/**
 * A file in the library. `deleting` is claimed before storage is deleted, and
 * stays listed in trash until the delete is finished.
 */
export const MEDIA_MACHINE = defineMachine({
    name: "media file",
    states: ["ready", "trashed", "deleting", "deleted"],
    initial: ["ready"],
    final: ["deleted"],
    moves: {
        trash: { from: ["ready"], to: "trashed" },
        restore: { from: ["trashed"], to: "ready" },
        delete: { from: ["trashed"], to: "deleting" },
        finish_delete: { from: ["deleting"], to: "deleted" },
    },
});

export type MediaMove = keyof typeof MEDIA_MACHINE.moves;

/** What the trash lists: files staff can restore, delete, or finish deleting. */
export const MEDIA_TRASH_STATES = ["trashed", "deleting"] as const;
