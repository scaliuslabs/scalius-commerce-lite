import { sha256HexSync } from "@scalius/shared/hash";

/**
 * One key for one push event, sent as the push service's collapse key (Web
 * Push `Topic`, FCM `collapse_key`, APNs `apns-collapse-id`): a send repeated
 * after the service answered "not processed" (HTTP 503) replaces a still-queued
 * first copy instead of alerting twice. 32 lowercase hex characters, within
 * Web Push's 32 URL-safe base64 characters and APNs's 64 bytes.
 */
export function pushCollapseKey(eventKey: string): string {
  return sha256HexSync(`push-collapse:${eventKey}`).slice(0, 32);
}
