import { BookOpen, GitCompareArrows, Inbox, Settings, type LucideIcon } from "lucide-react";
import type { MembershipRole, WorkspaceView } from "../types";

/** One rail / tab-bar entry. `chord` is the second key of the `g …` shortcut. */
export type NavItem = { view: WorkspaceView; label: string; icon: LucideIcon; chord: string };

/** Rail order (design-spec §3, minus Overview which lands with its own PR). Labels are spec contracts. */
export const NAV: NavItem[] = [
  { view: "inbox", label: "Inbox", icon: Inbox, chord: "i" },
  { view: "corrections", label: "Policy changes", icon: GitCompareArrows, chord: "p" },
  { view: "knowledge", label: "Knowledge", icon: BookOpen, chord: "k" },
  { view: "settings", label: "Settings", icon: Settings, chord: "s" },
];

/** `g` + this key opens the view (see useShortcuts). */
export const GO_KEYS: Record<string, WorkspaceView> = Object.fromEntries(NAV.map((n) => [n.chord, n.view]));

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/** Command-key glyph for keycaps: ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

export type ShortcutEntry = { keys: string[]; label: string };
export type ShortcutGroup = { heading: string; entries: ShortcutEntry[] };

/**
 * Everything the shortcut sheet lists. View-level keys (j/k to move in the
 * queue, enter to open, t to take, ⌘⏎ to send) are added by the inbox work;
 * append a group here and handle the keys through `useShortcuts`' `onKey`.
 */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    heading: "Go to",
    entries: NAV.map((n) => ({ keys: ["g", n.chord], label: n.label })),
  },
  {
    heading: "General",
    entries: [
      { keys: [MOD_LABEL, "K"], label: "Search and commands" },
      { keys: ["?"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close, or back to the thread list" },
    ],
  },
];

export function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function roleLabel(role: MembershipRole): string {
  return role === "demo" ? "demo access" : role;
}
