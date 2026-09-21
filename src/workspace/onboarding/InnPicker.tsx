import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer } from "../types";
import { Field, Notice } from "../lib/ui";
import { Mark } from "../lib/Mark";
import { useAsyncAction } from "../lib/hooks";
import { errorMessage, hostOf } from "../lib/format";

/**
 * "external": a real property whose own public site is crawled later.
 * "fictional": an inn whose example website this deployment hosts and the
 * owner edits in Settings; its URL is chosen by the server.
 */
type PropertyKind = "external" | "fictional";

/** Keeps the server's field message for `invalid` errors (the shared mapper flattens it). */
function createErrorMessage(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null) {
    const data = error.data as { code?: string; message?: string };
    if (data.code === "invalid" && data.message) return data.message;
  }
  return errorMessage(error);
}

/**
 * Shown to real staff who have no inn yet (onboarding) or who belong to
 * several and have not picked one. Creates the inn record only; connecting
 * the website crawl and the inbox happens on the server in a later slice.
 */
export function InnPicker({
  viewer,
  inns,
  onSelect,
}: {
  viewer: Viewer;
  inns: InnSummary[];
  onSelect: (innId: Id<"inns">) => void;
}) {
  const { signOut } = useAuthActions();
  const createInn = useMutation(api.inns.create);
  const createFictional = useMutation(api.innWebsites.createFictional);
  const [kind, setKind] = useState<PropertyKind>("external");
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "";
    }
  });
  const [showForm, setShowForm] = useState(inns.length === 0);
  const action = useAsyncAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (kind === "fictional") {
      const created = (await action.run(async () => {
        try {
          return await createFictional({ name, timezone: timezone || undefined });
        } catch (error) {
          throw new Error(createErrorMessage(error));
        }
      })) as { innId: Id<"inns">; siteUrl: string } | undefined;
      if (created) onSelect(created.innId);
      return;
    }
    const innId = (await action.run(() =>
      createInn({ name, siteUrl, timezone: timezone || undefined }),
    )) as Id<"inns"> | undefined;
    if (innId) onSelect(innId);
  }

  function chooseKind(next: PropertyKind) {
    setKind(next);
    action.clear();
  }

  return (
    <div className="fd-center">
      <div className="fd-center__panel fd-center__panel--wide">
        <div className="fd-wordmark">
          <Mark size={26} />
          <span>Front Desk</span>
        </div>
        <p className="fd-lede">
          Signed in as {viewer.name ?? viewer.email ?? "staff"}.{" "}
          {inns.length > 0 ? "Choose the property to work in." : "Set up your first property."}
        </p>

        {inns.length > 0 ? (
          <div className="fd-section">
            <p className="fd-section__title">Your properties</p>
            <ul className="fd-staff">
              {inns.map((inn) => (
                <li key={inn.innId}>
                  <span>
                    <strong>{inn.name}</strong>{" "}
                    <span className="fd-muted fd-small">
                      {hostOf(inn.siteUrl)} · {inn.role}
                      {inn.isDemo ? " · demo" : ""}
                    </span>
                  </span>
                  <button type="button" className="fd-btn fd-btn--small" onClick={() => onSelect(inn.innId)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {showForm ? (
          <form onSubmit={submit}>
            <p className="fd-section__title">New property</p>
            {/* Option labels deliberately avoid the words "Website" and
                "Property name": those are the labels of the inputs below.
                The kind is locked while a create is pending so the selected
                mode cannot diverge from the request already in flight. */}
            <fieldset className="fd-kind">
              <legend className="fd-field__label">What are you setting up?</legend>
              <label className="fd-kind__option">
                <input
                  type="radio"
                  name="fd-inn-kind"
                  checked={kind === "external"}
                  disabled={action.busy}
                  onChange={() => chooseKind("external")}
                />
                <span>
                  <strong>A real property with its own site</strong>
                  <span className="fd-muted fd-small">Replies are drafted only from what its public pages say.</span>
                </span>
              </label>
              <label className="fd-kind__option">
                <input
                  type="radio"
                  name="fd-inn-kind"
                  checked={kind === "fictional"}
                  disabled={action.busy}
                  onChange={() => chooseKind("fictional")}
                />
                <span>
                  <strong>A fictional inn with a hosted example site</strong>
                  <span className="fd-muted fd-small">
                    Front Desk hosts a small example site for it that you edit in Settings.
                  </span>
                </span>
              </label>
            </fieldset>
            <Field label="Property name" htmlFor="fd-inn-name">
              <input
                id="fd-inn-name"
                className="fd-input"
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {kind === "external" ? (
              <Field
                label="Website"
                htmlFor="fd-inn-url"
                hint="Replies are drafted only from what this site says. Must be a public site starting with https://."
              >
                <input
                  id="fd-inn-url"
                  className="fd-input"
                  type="url"
                  required
                  pattern="[Hh][Tt][Tt][Pp][Ss]://.*"
                  title="Must start with https://"
                  placeholder="https://"
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                />
              </Field>
            ) : null}
            <Field
              label="Time zone"
              htmlFor="fd-inn-tz"
              hint="The property's local time zone, stored on the inn record. An IANA name like America/New_York; leave blank for America/Los_Angeles."
            >
              <input
                id="fd-inn-tz"
                className="fd-input"
                placeholder="America/Los_Angeles"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </Field>
            {kind === "fictional" ? (
              <div style={{ marginBottom: 14 }}>
                <Notice tone="info">
                  This creates a public website with illustrative policies. Every page is labelled as a fictional inn.
                  Edit it in Settings, then use Knowledge to crawl it. Email and crawling require provider setup;
                  creating the inn does not start either.
                </Notice>
              </div>
            ) : null}
            {action.error ? <Notice tone="error">{action.error}</Notice> : null}
            <div className="fd-btn-row" style={{ marginTop: 14 }}>
              <button type="submit" className="fd-btn fd-btn--primary" disabled={action.busy}>
                {action.busy ? "Creating…" : kind === "fictional" ? "Create fictional inn" : "Create property"}
              </button>
              {inns.length > 0 ? (
                <button type="button" className="fd-btn fd-btn--quiet" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="fd-btn-row">
            <button type="button" className="fd-btn" onClick={() => setShowForm(true)}>
              Add another property
            </button>
          </div>
        )}

        <div className="fd-divider" />
        <button type="button" className="fd-btn fd-btn--quiet" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
