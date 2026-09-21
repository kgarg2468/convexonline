/**
 * Presence timing constants shared by the server (`convex/presence.ts`) and
 * the browser (`ThreadPresence`). Pure module on purpose: the UI must be able
 * to import the heartbeat interval without pulling the Convex server
 * entrypoint, component, or auth graph into its bundle.
 */

/** Clients heartbeat this often; the server passes the same value to the component. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Component rule: a session is dropped 2.5 intervals after its last heartbeat. */
export const PRESENCE_TTL_MS = HEARTBEAT_INTERVAL_MS * 2.5;
