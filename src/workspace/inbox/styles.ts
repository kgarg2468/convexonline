import type { ChipTone } from "./primitives";

/** Legacy pill tones (lib/format OUTBOX_LABEL and friends) mapped onto the chip tones. */
export const LEGACY_TONE: Record<"neutral" | "pine" | "caution" | "error" | "muted", ChipTone> = {
  neutral: "neutral",
  pine: "success",
  caution: "warning",
  error: "danger",
  muted: "muted",
};

/** Inbox controls are 28px beside a pointer and 44px under 901px, where a finger is the pointer (rows and tab bar already clear 44). */
export const touchControlClass = "max-[900px]:h-11";

/** Native select styled like the queue's chip-select (kept native where specs call `selectOption`). */
export const chipSelectClass =
  "h-7 max-[900px]:h-11 cursor-pointer appearance-none rounded-full border border-border-1 bg-bg-1 pr-6 pl-2.5 text-[13px] font-medium text-ink-1 outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50";

/** The thread's main column: scrolls on its own beside the queue, with the page on phones. */
export const threadMainClass = "min-w-0 bg-bg-1 min-[901px]:min-h-0 min-[901px]:overflow-y-auto";
/** Horizontal gutter shared by the sticky head and the content stack. */
export const threadPadClass = "px-4 min-[901px]:px-5";
/** Inbox typography for the shared primitives: 12px ink-3 helper lines and 11px ink-3 section labels. */
export const inboxHintClass = "text-[12px] leading-4 text-ink-3";
export const inboxLabelClass = "text-[11px] tracking-[0.08em] text-ink-3";
