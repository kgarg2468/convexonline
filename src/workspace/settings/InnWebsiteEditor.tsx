import { useState, type FormEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
// Type only: the server module never reaches the browser bundle.
import type { InnWebsiteContent } from "../../../convex/lib/innWebsiteHtml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ExternalLink, Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { errorMessage, formatStamp } from "../lib/format";
import { Hint } from "../inbox/primitives";
import { ActionRow, KeyValue, KeyValueList, SettingsSection } from "./primitives";

/** Mirror of `innWebsites.editor` (owner) and `innWebsites.publicView` (any member). */
type EditorData = { siteUrl: string; pages: string[]; content: InnWebsiteContent; updatedAt: number };
type MemberData = { siteUrl: string; pages: string[]; content: InnWebsiteContent };

type ContentField = keyof InnWebsiteContent;
/** Every field as the text of its input; numbers are parsed only when saving. */
type FormValues = Record<ContentField, string>;

const FIELDS: readonly ContentField[] = [
  "publicName",
  "intro",
  "checkIn",
  "checkOut",
  "petFeePerDogPerNight",
  "maxDogs",
  "petPolicy",
  "breakfastHours",
  "wifi",
  "roomsDescription",
  "notice",
];

function toForm(content: InnWebsiteContent): FormValues {
  const out = {} as FormValues;
  for (const field of FIELDS) out[field] = String(content[field]);
  return out;
}

function toContent(form: FormValues): InnWebsiteContent {
  return {
    publicName: form.publicName,
    intro: form.intro,
    checkIn: form.checkIn,
    checkOut: form.checkOut,
    petFeePerDogPerNight: Number(form.petFeePerDogPerNight),
    maxDogs: Number(form.maxDogs),
    petPolicy: form.petPolicy,
    breakfastHours: form.breakfastHours,
    wifi: form.wifi,
    roomsDescription: form.roomsDescription,
    notice: form.notice,
  };
}

function sameForm(a: FormValues, b: FormValues): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

/**
 * The shared error mapper turns every `invalid` code into one generic sentence;
 * for this form the server's field message ("petPolicy must be at most 800
 * characters") is the useful part, so it is kept.
 */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as { code?: string; message?: string };
    if (data.code === "invalid" && data.message) return data.message;
  }
  return errorMessage(error);
}

/** Inputs sit on white inside the section; 14px like the rest of the page. */
const inputClass = "bg-white text-[14px] text-ink-1 md:text-[14px]";
const areaClass = "resize-y bg-white px-3 py-2 text-[14px] leading-[1.55] text-ink-1 md:text-[14px]";
/** Minimum heights for the `rows` the fields ask for (the textarea sizes to its content beyond that). */
const AREA_HEIGHT: Record<number, string> = { 3: "min-h-20", 4: "min-h-24", 5: "min-h-28" };

/** "Home", "Policies", … from a hosted page URL (`/inn/<id>/<segment>`). */
function pageLabel(url: string): string {
  try {
    const segment = new URL(url).pathname.split("/").filter((s) => s.length > 0)[2] ?? "";
    return segment === "" ? "Home" : segment[0]!.toUpperCase() + segment.slice(1);
  } catch {
    return url;
  }
}

function PageLinks({ pages }: { pages: string[] }) {
  if (pages.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[13px] leading-5" aria-label="Public pages">
      {pages.map((url) => (
        <li key={url}>
          <ExternalLink href={url}>{pageLabel(url)}</ExternalLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The "Public website" section (design-spec §4.5) every inn has: the inn
 * record's website address first, then whatever the inn's hosting allows
 * (the editor, the read-only view, or nothing more for an external site).
 */
export function PublicWebsiteSection({
  siteUrl,
  description,
  children,
}: {
  siteUrl: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingsSection id="fd-site-title" role="region" title="Public website" description={description}>
      <KeyValueList>
        <KeyValue term="Website">
          <ExternalLink href={siteUrl}>{siteUrl}</ExternalLink>
        </KeyValue>
      </KeyValueList>
      {children}
    </SettingsSection>
  );
}

/**
 * The Public website section of a real inn. When Front Desk hosts the inn's
 * fictional website, owners (real accounts only) get the structured editor
 * backed by the owner-only query and every other member gets the read-only
 * public view. An external property (no website document) keeps the section
 * with the address alone; while the query is in flight the section shows the
 * address and nothing else, so the heading never moves.
 *
 * Saving only rewrites the public site. Captured pages, claims and
 * corrections change through the ordinary crawl, never from here.
 */
export function InnWebsiteEditor({ innId, siteUrl, canEdit }: { innId: Id<"inns">; siteUrl: string; canEdit: boolean }) {
  return canEdit ? <OwnerEditor innId={innId} siteUrl={siteUrl} /> : <MemberView innId={innId} siteUrl={siteUrl} />;
}

/** The section of an inn whose website Front Desk does not host, or whose website query has not answered yet. */
function ExternalSite({ siteUrl, known }: { siteUrl: string; known: boolean }) {
  return (
    <PublicWebsiteSection
      siteUrl={siteUrl}
      description={
        known
          ? "Front Desk does not host this property's website. Replies are drafted from the pages captured from it in Knowledge."
          : undefined
      }
    />
  );
}

function OwnerEditor({ innId, siteUrl }: { innId: Id<"inns">; siteUrl: string }) {
  const data = useQuery(api.innWebsites.editor, { innId }) as EditorData | null | undefined;
  if (data === undefined || data === null) return <ExternalSite siteUrl={siteUrl} known={data === null} />;
  return <OwnerForm innId={innId} data={data} />;
}

function OwnerForm({ innId, data }: { innId: Id<"inns">; data: EditorData }) {
  const update = useMutation(api.innWebsites.update);
  const action = useAsyncAction();
  // Unsaved edits live here and survive reactive updates of `data`; null means
  // the form shows exactly what the server has.
  const [draft, setDraft] = useState<FormValues | null>(null);
  // The server version the draft started from, to notice concurrent saves.
  const [draftBase, setDraftBase] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const server = toForm(data.content);
  const values = draft ?? server;
  const dirty = draft !== null && !sameForm(draft, server);
  const changedElsewhere = dirty && draftBase !== null && draftBase !== data.updatedAt;

  function edit(field: ContentField, value: string) {
    if (draft === null) setDraftBase(data.updatedAt);
    setDraft({ ...(draft ?? server), [field]: value });
    if (action.error) action.clear();
  }

  function discard() {
    setDraft(null);
    setDraftBase(null);
    action.clear();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft === null) return;
    const content = toContent(draft);
    const result = (await action.run(async () => {
      try {
        return await update({ innId, content });
      } catch (error) {
        throw new Error(saveErrorMessage(error));
      }
    })) as { updatedAt: number } | undefined;
    if (!result) return;
    setDraft(null);
    setDraftBase(null);
    setSavedAt(result.updatedAt);
  }

  // Every field is locked while a save is in flight: the draft is cleared when
  // the save completes, so keystrokes typed meanwhile would be lost.
  const text = (field: ContentField, id: string, extra?: { placeholder?: string }) => (
    <Input
      id={id}
      className={inputClass}
      value={values[field]}
      placeholder={extra?.placeholder}
      disabled={action.busy}
      onChange={(e) => edit(field, e.target.value)}
    />
  );
  const area = (field: ContentField, id: string, rows: number) => (
    <Textarea
      id={id}
      className={cn(areaClass, AREA_HEIGHT[rows])}
      rows={rows}
      value={values[field]}
      disabled={action.busy}
      onChange={(e) => edit(field, e.target.value)}
    />
  );

  return (
    <PublicWebsiteSection
      siteUrl={data.siteUrl}
      description="Front Desk hosts this inn's website. It is public: anyone with the link can read it, and every page is labelled as a fictional inn. The values below are the whole site; nothing else about the inn is published."
    >
      <SiteLinks siteUrl={data.siteUrl} pages={data.pages}>
        Last saved {formatStamp(data.updatedAt)}. Replies are drafted from the pages the crawl captured, not from this
        form: after saving, open Knowledge and run “Crawl the website” so the new text is captured and any sent
        replies that quoted the old text are re-checked. Saving here never starts a crawl.
      </SiteLinks>

      <form className="mt-1 flex flex-col gap-4" onSubmit={(e) => void save(e)}>
        <Field label="Public name" htmlFor="fd-site-name" hint="The name shown on every page. The inn record's own name is unchanged.">
          {text("publicName", "fd-site-name")}
        </Field>
        <Field label="Introduction" htmlFor="fd-site-intro" hint="Home page opening text. Blank lines separate paragraphs.">
          {area("intro", "fd-site-intro", 4)}
        </Field>
        <div className="grid gap-4 min-[600px]:grid-cols-2">
          <Field label="Check-in time" htmlFor="fd-site-checkin">
            {text("checkIn", "fd-site-checkin", { placeholder: "3:00 PM" })}
          </Field>
          <Field label="Check-out time" htmlFor="fd-site-checkout">
            {text("checkOut", "fd-site-checkout", { placeholder: "11:00 AM" })}
          </Field>
          <Field label="Pet fee per dog per night (USD)" htmlFor="fd-site-petfee" hint="Whole dollars, 0 to 500.">
            {/* Bounds mirror the server's limits; the server is the one that decides. */}
            <Input
              id="fd-site-petfee"
              className={inputClass}
              type="number"
              inputMode="numeric"
              min={0}
              max={500}
              step={1}
              required
              disabled={action.busy}
              value={values.petFeePerDogPerNight}
              onChange={(e) => edit("petFeePerDogPerNight", e.target.value)}
            />
          </Field>
          <Field
            label="Maximum dogs per room"
            htmlFor="fd-site-maxdogs"
            hint="0 to 6. At 0 the site states that pets are not permitted; keep the pet policy and rooms text below consistent with that."
          >
            <Input
              id="fd-site-maxdogs"
              className={inputClass}
              type="number"
              inputMode="numeric"
              min={0}
              max={6}
              step={1}
              required
              disabled={action.busy}
              value={values.maxDogs}
              onChange={(e) => edit("maxDogs", e.target.value)}
            />
          </Field>
          <Field label="Breakfast hours" htmlFor="fd-site-breakfast">
            {text("breakfastHours", "fd-site-breakfast", { placeholder: "7:00 AM to 9:00 AM" })}
          </Field>
          <Field label="Wi-Fi" htmlFor="fd-site-wifi" hint="Optional one-line note.">
            {text("wifi", "fd-site-wifi")}
          </Field>
        </div>
        <Field
          label="Pet policy"
          htmlFor="fd-site-petpolicy"
          hint="Shown under the fee and dog limit above; say the same thing they do."
        >
          {area("petPolicy", "fd-site-petpolicy", 4)}
        </Field>
        <Field label="Rooms" htmlFor="fd-site-rooms" hint="Rooms page text; mention pet-friendly rooms only if dogs are allowed.">
          {area("roomsDescription", "fd-site-rooms", 5)}
        </Field>
        <Field label="Current notice" htmlFor="fd-site-notice" hint="Optional. Shown on the home and notices pages while present.">
          {area("notice", "fd-site-notice", 3)}
        </Field>

        {changedElsewhere ? (
          <Notice tone="caution">
            The website was saved from another session since you started editing. Saving overwrites it with the values
            here; discard to load the latest.
          </Notice>
        ) : null}
        {action.error ? (
          <Notice tone="error" role="alert">
            {action.error}
          </Notice>
        ) : null}
        <ActionRow className="border-t border-border-1 pt-4">
          <Button type="submit" disabled={!dirty || action.busy}>
            {action.busy ? "Saving…" : "Save website"}
          </Button>
          {dirty ? (
            <Button type="button" variant="ghost" className="text-ink-1" disabled={action.busy} onClick={discard}>
              Discard changes
            </Button>
          ) : null}
          <span className="text-[13px] leading-5 text-ink-2" role="status">
            {action.busy
              ? "Saving to the public website…"
              : dirty
                ? "Unsaved changes. Saving publishes them immediately."
                : savedAt !== null && savedAt === data.updatedAt
                  ? `Website saved ${formatStamp(savedAt)}.`
                  : "No unsaved changes."}
          </span>
        </ActionRow>
      </form>
    </PublicWebsiteSection>
  );
}

/** "Open the public website", the page links, and a hint under them. */
function SiteLinks({ siteUrl, pages, children }: { siteUrl: string; pages: string[]; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-1 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 text-[14px] leading-5">
        <ExternalLink href={siteUrl} className="font-medium">
          Open the public website
        </ExternalLink>
        <PageLinks pages={pages} />
      </div>
      {children ? <Hint className="max-w-[64ch]">{children}</Hint> : null}
    </div>
  );
}

function MemberView({ innId, siteUrl }: { innId: Id<"inns">; siteUrl: string }) {
  const data = useQuery(api.innWebsites.publicView, { innId }) as MemberData | null | undefined;
  if (data === undefined || data === null) return <ExternalSite siteUrl={siteUrl} known={data === null} />;
  const c = data.content;
  return (
    <PublicWebsiteSection
      siteUrl={data.siteUrl}
      description="Front Desk hosts this inn's website. It is public and every page is labelled as a fictional inn. Only the inn owner can edit the website."
    >
      <SiteLinks siteUrl={data.siteUrl} pages={data.pages} />
      <KeyValueList>
        <KeyValue term="Public name">{c.publicName}</KeyValue>
        <KeyValue term="Check-in">{c.checkIn}</KeyValue>
        <KeyValue term="Check-out">{c.checkOut}</KeyValue>
        <KeyValue term="Dogs">
          {c.maxDogs === 0 ? "Not permitted" : `$${c.petFeePerDogPerNight} per dog per night, up to ${c.maxDogs} per room`}
        </KeyValue>
        <KeyValue term="Breakfast">{c.breakfastHours}</KeyValue>
      </KeyValueList>
    </PublicWebsiteSection>
  );
}
