import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer } from "../types";
import { Field, Notice } from "../lib/ui";
import { Mark } from "../lib/Mark";
import { useAsyncAction } from "../lib/hooks";
import { hostOf } from "../lib/format";

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
    const innId = (await action.run(() =>
      createInn({ name, siteUrl, timezone: timezone || undefined }),
    )) as Id<"inns"> | undefined;
    if (innId) onSelect(innId);
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
            <Field
              label="Website"
              htmlFor="fd-inn-url"
              hint="Replies are drafted only from what this site says. Include https://."
            >
              <input
                id="fd-inn-url"
                className="fd-input"
                type="url"
                required
                placeholder="https://"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
            </Field>
            <Field label="Time zone" htmlFor="fd-inn-tz" hint="Used for arrival and follow-up times.">
              <input
                id="fd-inn-tz"
                className="fd-input"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </Field>
            {action.error ? <Notice tone="error">{action.error}</Notice> : null}
            <div className="fd-btn-row" style={{ marginTop: 14 }}>
              <button type="submit" className="fd-btn fd-btn--primary" disabled={action.busy}>
                {action.busy ? "Creating…" : "Create property"}
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
