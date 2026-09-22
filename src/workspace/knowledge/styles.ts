import type { ChipTone } from "../inbox/primitives";
import type { ChangeStatus, CrawlRun } from "../types";

/** A hairline panel (design-spec §1: 10px radius, no in-page shadow). */
export const panelClass = "rounded-[10px] border border-border-1 bg-white";

/**
 * The page table's row geometry: one column on phones, five beside each other
 * from 901px (title + kind | path | watched | latest version | actions).
 */
export const pageGridClass =
  "grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-2.5 min-[901px]:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_max-content_minmax(0,1.8fr)_max-content] min-[901px]:items-center";

/** 12px tertiary meta line (hash · captured, author · date). */
export const metaClass = "text-[12px] leading-4 text-ink-3 tabular-nums";

/** The label the specs and staff know each capture outcome by, and its chip tone. */
export const CHANGE_STATUS: Record<ChangeStatus, { label: string; tone: ChipTone }> = {
  new: { label: "First capture", tone: "neutral" },
  same: { label: "Unchanged", tone: "muted" },
  changed: { label: "Changed", tone: "danger" },
};

export const RUN_STATUS: Record<CrawlRun["status"], { label: string; tone: ChipTone }> = {
  running: { label: "Running", tone: "neutral" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};
