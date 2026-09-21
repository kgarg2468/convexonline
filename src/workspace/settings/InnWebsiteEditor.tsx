import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
// Type only: the server module never reaches the browser bundle.
import type { InnWebsiteContent } from "../../../convex/lib/innWebsiteHtml";
import { ExternalLink, Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { errorMessage, formatStamp } from "../lib/format";

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
    <ul className="fd-site__pages" aria-label="Public pages">
      {pages.map((url) => (
        <li key={url}>
          <ExternalLink href={url}>{pageLabel(url)}</ExternalLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The hosted fictional website of an inn, when it has one. Owners (real
 * accounts only) get the structured editor backed by the owner-only query;
 * every other member gets the read-only public view. Inns without a website
 * document (external properties) render nothing at all.
 *
 * Saving only rewrites the public site. Captured pages, claims and
 * corrections change through the ordinary crawl, never from here.
 */
export function InnWebsiteEditor({ innId, canEdit }: { innId: Id<"inns">; canEdit: boolean }) {
  return canEdit ? <OwnerEditor innId={innId} /> : <MemberView innId={innId} />;
}

function OwnerEditor({ innId }: { innId: Id<"inns"> }) {
  const data = useQuery(api.innWebsites.editor, { innId }) as EditorData | null | undefined;
  if (data === undefined || data === null) return null;
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
    <input
      id={id}
      className="fd-input"
      value={values[field]}
      placeholder={extra?.placeholder}
      disabled={action.busy}
      onChange={(e) => edit(field, e.target.value)}
    />
  );
  const area = (field: ContentField, id: string, rows: number) => (
    <textarea
      id={id}
      className="fd-textarea"
      rows={rows}
      value={values[field]}
      disabled={action.busy}
      onChange={(e) => edit(field, e.target.value)}
    />
  );

  return (
    <div className="fd-section fd-site" role="region" aria-labelledby="fd-site-title">
      <p className="fd-section__title" id="fd-site-title">
        Public website
      </p>
      <div className="fd-card">
        <p className="fd-site__lede">
          Front Desk hosts this inn's website. It is public: anyone with the link can read it, and every page is
          labelled as a fictional inn. The values below are the whole site; nothing else about the inn is published.
        </p>
        <div className="fd-site__links">
          <ExternalLink href={data.siteUrl}>Open the public website</ExternalLink>
          <PageLinks pages={data.pages} />
        </div>
        <p className="fd-muted fd-small">
          Last saved {formatStamp(data.updatedAt)}. Replies are drafted from the pages the crawl captured, not from this
          form: after saving, open Knowledge and run “Crawl the website” so the new text is captured and any sent
          replies that quoted the old text are re-checked. Saving here never starts a crawl.
        </p>
      </div>

      <form className="fd-site__form" onSubmit={(e) => void save(e)}>
        <Field label="Public name" htmlFor="fd-site-name" hint="The name shown on every page. The inn record's own name is unchanged.">
          {text("publicName", "fd-site-name")}
        </Field>
        <Field label="Introduction" htmlFor="fd-site-intro" hint="Home page opening text. Blank lines separate paragraphs.">
          {area("intro", "fd-site-intro", 4)}
        </Field>
        <div className="fd-site__grid">
          <Field label="Check-in time" htmlFor="fd-site-checkin">
            {text("checkIn", "fd-site-checkin", { placeholder: "3:00 PM" })}
          </Field>
          <Field label="Check-out time" htmlFor="fd-site-checkout">
            {text("checkOut", "fd-site-checkout", { placeholder: "11:00 AM" })}
          </Field>
          <Field label="Pet fee per dog per night (USD)" htmlFor="fd-site-petfee" hint="Whole dollars, 0 to 500.">
            {/* Bounds mirror the server's limits; the server is the one that decides. */}
            <input
              id="fd-site-petfee"
              className="fd-input"
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
            <input
              id="fd-site-maxdogs"
              className="fd-input"
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
          <div style={{ marginBottom: 8 }}>
            <Notice tone="caution">
              The website was saved from another session since you started editing. Saving overwrites it with the values
              here; discard to load the latest.
            </Notice>
          </div>
        ) : null}
        {action.error ? (
          <div style={{ marginBottom: 8 }}>
            <Notice tone="error">{action.error}</Notice>
          </div>
        ) : null}
        <div className="fd-btn-row fd-site__toolbar">
          <button type="submit" className="fd-btn fd-btn--primary" disabled={!dirty || action.busy}>
            {action.busy ? "Saving…" : "Save website"}
          </button>
          {dirty ? (
            <button type="button" className="fd-btn fd-btn--quiet" disabled={action.busy} onClick={discard}>
              Discard changes
            </button>
          ) : null}
          <span className="fd-muted fd-small" role="status">
            {action.busy
              ? "Saving to the public website…"
              : dirty
                ? "Unsaved changes. Saving publishes them immediately."
                : savedAt !== null && savedAt === data.updatedAt
                  ? `Website saved ${formatStamp(savedAt)}.`
                  : "No unsaved changes."}
          </span>
        </div>
      </form>
    </div>
  );
}

function MemberView({ innId }: { innId: Id<"inns"> }) {
  const data = useQuery(api.innWebsites.publicView, { innId }) as MemberData | null | undefined;
  if (data === undefined || data === null) return null;
  const c = data.content;
  return (
    <div className="fd-section fd-site" role="region" aria-labelledby="fd-site-title">
      <p className="fd-section__title" id="fd-site-title">
        Public website
      </p>
      <div className="fd-card">
        <p className="fd-site__lede">
          Front Desk hosts this inn's website. It is public and every page is labelled as a fictional inn. Only the inn
          owner can edit the website.
        </p>
        <div className="fd-site__links">
          <ExternalLink href={data.siteUrl}>Open the public website</ExternalLink>
          <PageLinks pages={data.pages} />
        </div>
        <dl className="fd-kv">
          <dt>Public name</dt>
          <dd>{c.publicName}</dd>
          <dt>Check-in</dt>
          <dd>{c.checkIn}</dd>
          <dt>Check-out</dt>
          <dd>{c.checkOut}</dd>
          <dt>Dogs</dt>
          <dd>{c.maxDogs === 0 ? "Not permitted" : `$${c.petFeePerDogPerNight} per dog per night, up to ${c.maxDogs} per room`}</dd>
          <dt>Breakfast</dt>
          <dd>{c.breakfastHours}</dd>
        </dl>
      </div>
    </div>
  );
}
