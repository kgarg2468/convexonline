import type { Correction } from "../types";
import type { ChipTone } from "../inbox/primitives";

/** Status chip per correction status: needs-you = warning tint, approved = accent outline, sent = success, history quiet. */
export const STATUS_CHIP: Record<Correction["status"], { label: string; tone: ChipTone }> = {
  needs_review: { label: "Needs review", tone: "warning" },
  approved: { label: "Approved, not sent", tone: "accentOutline" },
  sent: { label: "Correction sent", tone: "success" },
  dismissed: { label: "Dismissed", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
};

/** Provenance chip: staff-written text carries the secondary marker (design-spec §1); model and fixture text stay quiet. */
export const SOURCE_CHIP: Record<NonNullable<Correction["textSource"]>, { label: string; tone: ChipTone }> = {
  generated: { label: "Drafter proposal", tone: "muted" },
  staff: { label: "Staff-written", tone: "secondary" },
  fixture: { label: "Demo fixture proposal", tone: "muted" },
};

/** A page path rendered as a link to the live page (the sources pane uses the same look). */
export const pathLinkClass =
  "rounded-sm text-accent-10 underline-offset-4 outline-hidden transition-colors duration-micro hover:underline focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2";

/** Outline buttons on a white card. */
export const outlineButtonClass = "bg-white text-[13px] text-ink-1";

/** A passage quoted from the website or from a sent message: Newsreader italic, wraps anywhere. */
export const passageClass =
  "rounded-md border-l-2 border-border-2 bg-bg-1 px-3 py-2 font-serif text-[15px] leading-[1.55] text-ink-1 italic whitespace-pre-wrap [overflow-wrap:anywhere]";

/** A read-only text box (the recorded correction text). */
export const textBoxClass =
  "rounded-md border border-border-1 bg-bg-1 px-3 py-2.5 text-[14px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-1";

/** The section headings of the review page (the header carries the h1). */
export const sectionHeadingClass = "text-[12px] leading-4 font-semibold tracking-[0.06em] text-ink-2 uppercase";
