import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError } from "../errors";

export function CreateInn({ onCreated }: { onCreated: (innId: Id<"inns">) => void }) {
  const create = useMutation(api.inns.create);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const innId = await create({
        name: String(form.get("name") ?? ""),
        siteUrl: String(form.get("siteUrl") ?? ""),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      onCreated(innId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" style={{ maxWidth: 480 }}>
      <h2>Set up your inn</h2>
      <form onSubmit={submit}>
        <label>
          Inn name
          <input name="name" required maxLength={120} />
        </label>
        <label>
          Website
          <input name="siteUrl" type="url" required placeholder="https://" />
        </label>
        <button type="submit" disabled={busy} style={{ marginTop: 8 }}>
          Create inn
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
