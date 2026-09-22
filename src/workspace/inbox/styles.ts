import type { ChipTone } from "./primitives";

/** Legacy pill tones (lib/format OUTBOX_LABEL and friends) mapped onto the chip tones. */
export const LEGACY_TONE: Record<"neutral" | "pine" | "caution" | "error" | "muted", ChipTone> = {
  neutral: "neutral",
  pine: "success",
  caution: "warning",
  error: "danger",
  muted: "muted",
};

/** Native select styled like the queue's chip-select (kept native where specs call `selectOption`). */
export const chipSelectClass =
  "h-7 cursor-pointer appearance-none rounded-full border border-border-1 bg-bg-1 pr-6 pl-2.5 text-[13px] font-medium text-ink-1 outline-hidden transition-colors duration-micro hover:bg-bg-2 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50";

/** The thread's main column: scrolls on its own beside the queue, with the page on phones. */
export const threadMainClass = "min-w-0 bg-bg-1 min-[901px]:min-h-0 min-[901px]:overflow-y-auto";
/** Horizontal gutter shared by the sticky head and the content stack. */
export const threadPadClass = "px-4 min-[901px]:px-6";
