import { useEffect, useRef } from "react";
import type { WorkspaceView } from "../types";
import { GO_KEYS } from "./nav";

/** How long the `g` prefix waits for its second key. */
export const CHORD_MS = 600;

export type ShortcutHandlers = {
  /** `g` then `i` / `p` / `k` / `s`. */
  onGo: (view: WorkspaceView) => void;
  /** ⌘K / Ctrl-K, also while a dialog is open (so the palette can toggle itself). */
  onTogglePalette: () => void;
  /** `?` */
  onHelp: () => void;
  /** Esc with no dialog open and focus outside a field: the workspace decides (e.g. mobile detail → list). */
  onEscape: () => void;
  /**
   * Extension point for view-level keys (j/k/enter/t and friends belong to the
   * inbox work): called for plain keydowns that nothing above claimed, never
   * while typing or with a dialog open. Return true after handling.
   */
  onKey?: (event: KeyboardEvent) => boolean;
};

/** Focus is in something that takes typing: shortcuts must not steal it. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** A Radix dialog, sheet or menu is open: it owns the keyboard. */
export function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
    ) !== null
  );
}

/**
 * Global keyboard shortcuts for the shell. Keyboard navigation reuses the same
 * route transitions as clicks (it is navigation, not an inline action).
 * Handlers are read through a ref so the listener is installed once.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let chord = false;
    let timer: number | null = null;
    const clearChord = () => {
      chord = false;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const h = ref.current;
      if (event.defaultPrevented || event.isComposing) return;

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        clearChord();
        h.onTogglePalette();
        return;
      }

      if (event.key === "Escape") {
        clearChord();
        // Radix closes its own overlays; a field keeps its Esc (clearing a search, for example).
        if (!overlayOpen() && !isEditable(event.target)) h.onEscape();
        return;
      }

      if (isEditable(event.target) || overlayOpen() || event.metaKey || event.ctrlKey || event.altKey) {
        clearChord();
        return;
      }

      if (chord) {
        const view = GO_KEYS[event.key.toLowerCase()];
        clearChord();
        if (view) {
          event.preventDefault();
          h.onGo(view);
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        h.onHelp();
        return;
      }
      if (event.key === "g") {
        chord = true;
        timer = window.setTimeout(clearChord, CHORD_MS);
        return;
      }

      if (h.onKey?.(event)) event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearChord();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
