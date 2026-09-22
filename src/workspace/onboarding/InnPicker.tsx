import { useState, type FormEvent } from "react";
import { ConvexError } from "convex/values";
import { useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer } from "../types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Notice } from "../lib/ui";
import { useAsyncAction } from "../lib/hooks";
import { errorMessage, hostOf } from "../lib/format";
import { SectionLabel } from "../inbox/primitives";
import { AuthCard, AuthScreen, CardText, OrDivider, Wordmark } from "../auth/AuthCard";

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
    <AuthScreen>
      <AuthCard>
        <div className="flex flex-col gap-3">
          <Wordmark />
          <CardText>
            Signed in as {viewer.name ?? viewer.email ?? "staff"}.{" "}
            {inns.length > 0 ? "Choose the property to work in." : "Set up your first property."}
          </CardText>
        </div>

        {inns.length > 0 ? (
          <section aria-labelledby="fd-picker-list-title" className="flex flex-col gap-2">
            <SectionLabel id="fd-picker-list-title" as="h3">
              Your properties
            </SectionLabel>
            <ul className="divide-y divide-border-1 rounded-md border border-border-1">
              {inns.map((inn) => (
                <li key={inn.innId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="flex min-w-0 flex-col">
                    <strong className="truncate text-[14px] leading-5 font-semibold text-ink-1">{inn.name}</strong>
                    <span className="truncate text-[12px] leading-4 text-ink-2">
                      {hostOf(inn.siteUrl)} · {inn.role}
                      {inn.isDemo ? " · demo" : ""}
                    </span>
                  </span>
                  <Button type="button" variant="outline" size="sm" className="shrink-0 text-ink-1" onClick={() => onSelect(inn.innId)}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {showForm ? (
          <form onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="fd-picker-form-title">
            <SectionLabel id="fd-picker-form-title" as="h3">
              New property
            </SectionLabel>
            {/* Option labels deliberately avoid the words "Website" and
                "Property name": those are the labels of the inputs below.
                The kind is locked while a create is pending so the selected
                mode cannot diverge from the request already in flight. */}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[13px] leading-5 font-medium text-ink-1">What are you setting up?</legend>
              <KindOption
                checked={kind === "external"}
                disabled={action.busy}
                onChange={() => chooseKind("external")}
                title="A real property with its own site"
                body="Replies are drafted only from what its public pages say."
              />
              <KindOption
                checked={kind === "fictional"}
                disabled={action.busy}
                onChange={() => chooseKind("fictional")}
                title="A fictional inn with a hosted example site"
                body="Front Desk hosts a small example site for it that you edit in Settings."
              />
            </fieldset>
            <Field label="Property name" htmlFor="fd-inn-name">
              <Input id="fd-inn-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {kind === "external" ? (
              <Field
                label="Website"
                htmlFor="fd-inn-url"
                hint="Replies are drafted only from what this site says. Must be a public site starting with https://."
              >
                <Input
                  id="fd-inn-url"
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
              <Input id="fd-inn-tz" placeholder="America/Los_Angeles" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </Field>
            {kind === "fictional" ? (
              <Notice tone="info">
                This creates a public website with illustrative policies. Every page is labelled as a fictional inn.
                Edit it in Settings, then use Knowledge to crawl it. Email and crawling require provider setup;
                creating the inn does not start either.
              </Notice>
            ) : null}
            {action.error ? <Notice tone="error">{action.error}</Notice> : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" size="lg" className="w-full" disabled={action.busy}>
                {action.busy ? "Creating…" : kind === "fictional" ? "Create fictional inn" : "Create property"}
              </Button>
              {inns.length > 0 ? (
                <Button type="button" variant="ghost" size="lg" className="w-full text-ink-1" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <Button type="button" variant="outline" size="lg" className="w-full text-ink-1" onClick={() => setShowForm(true)}>
            Add another property
          </Button>
        )}

        <OrDivider />
        <Button type="button" variant="ghost" size="sm" className="self-start text-[13px] text-ink-2" onClick={() => void signOut()}>
          Sign out
        </Button>
      </AuthCard>
    </AuthScreen>
  );
}

/** One kind of property: a bordered radio row whose whole surface is the label. */
function KindOption({
  checked,
  disabled,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors duration-micro",
        checked ? "border-accent-9 bg-accent-2" : "border-border-1 bg-white hover:bg-bg-2",
        disabled && "cursor-default opacity-70",
      )}
    >
      <input
        type="radio"
        name="fd-inn-kind"
        className="mt-1 size-3.5 shrink-0 accent-accent-9"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-[14px] leading-5 font-semibold text-ink-1">{title}</strong>
        <span className="text-[12px] leading-4 text-ink-2">{body}</span>
      </span>
    </label>
  );
}
