import { useCallback, useEffect, useState } from "react";

/**
 * Invitation links carry their one-use token in the URL fragment
 * (`https://host/#invite=<token>`), never in the query string, so the token
 * is not sent to the static host, does not land in server logs and is not
 * part of any referrer. The fragment is read once, moved into per-tab
 * sessionStorage and stripped from the address bar; it survives the sign-in
 * or sign-up round trip and a reload in this tab, and nothing else.
 */

export const INVITE_FRAGMENT_PREFIX = "#invite=";
const STORAGE_KEY = "frontdesk.pendingInvite";
/**
 * Loose enough to capture a mistyped or truncated link (the server then
 * reports it as not valid, which is the honest answer), tight enough that
 * arbitrary fragments never end up in storage.
 */
const CAPTURABLE_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
/**
 * Stored in place of a token when an invitation fragment was opened but could
 * not be read as one (bad percent-encoding, wrong characters, empty, too
 * long). Deliberately fails CAPTURABLE_TOKEN so it can never be mistaken for
 * a token, and the raw fragment is never kept or shown.
 */
const MALFORMED_MARK = "!malformed";

/**
 * What this tab is holding: a token to preview and maybe join, or the fact
 * that an invitation link was opened that cannot be read. The second case
 * is kept so the person sees an honest "not valid" state they can dismiss,
 * rather than silently falling back to whatever was pending before.
 */
export type PendingInvite = { kind: "token"; token: string } | { kind: "malformed" };

/** In-memory fallback when sessionStorage is unavailable (privacy modes, quota, sandboxed frames). */
let memoryInvite: PendingInvite | null = null;

function fromStored(stored: string): PendingInvite | null {
  if (stored === MALFORMED_MARK) return { kind: "malformed" };
  return CAPTURABLE_TOKEN.test(stored) ? { kind: "token", token: stored } : null;
}

function readStored(): PendingInvite | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) return fromStored(stored);
  } catch {
    /* storage unavailable */
  }
  return memoryInvite;
}

function store(invite: PendingInvite) {
  memoryInvite = invite;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, invite.kind === "token" ? invite.token : MALFORMED_MARK);
  } catch {
    /* storage unavailable; the in-memory copy still carries it through this page's life */
  }
}

function clearStored() {
  memoryInvite = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

/**
 * If the current location carries an invitation fragment, consumes it:
 * removes only that fragment from the address bar (path and query are kept)
 * and returns the token, or `malformed` when the fragment cannot be read as
 * one. Any other fragment is left alone and yields null. Never throws:
 * `decodeURIComponent` rejects bad percent-encoding such as `%E0%A4%A`, and
 * this runs during the root's first render.
 */
export function captureInviteFromLocation(): PendingInvite | null {
  const hash = window.location.hash;
  if (!hash.startsWith(INVITE_FRAGMENT_PREFIX)) return null;
  const raw = hash.slice(INVITE_FRAGMENT_PREFIX.length);
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  } catch {
    /* history unavailable; the fragment is still consumed below */
  }
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    return { kind: "malformed" };
  }
  return CAPTURABLE_TOKEN.test(token) ? { kind: "token", token } : { kind: "malformed" };
}

/** The canonical link for a token: this app's origin, root path, fragment only. */
export function inviteLink(token: string, origin = window.location.origin): string {
  return `${origin}/${INVITE_FRAGMENT_PREFIX}${token}`;
}

/**
 * The invitation this tab is holding, if any. Captured from the fragment on
 * first render (and again on `hashchange`, so a link opened into an already
 * signed-in tab is picked up), otherwise restored from this tab's storage.
 * A newly opened link always replaces what was pending, even when the new
 * one is malformed: opening a broken link must never quietly offer the
 * property from an earlier one.
 */
export function usePendingInvite(): { invite: PendingInvite | null; clear: () => void } {
  const [invite, setInvite] = useState<PendingInvite | null>(() => {
    const captured = captureInviteFromLocation();
    if (captured) {
      store(captured);
      return captured;
    }
    return readStored();
  });

  useEffect(() => {
    const onHashChange = () => {
      const captured = captureInviteFromLocation();
      if (captured) {
        store(captured);
        setInvite(captured);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const clear = useCallback(() => {
    clearStored();
    setInvite(null);
  }, []);

  return { invite, clear };
}
