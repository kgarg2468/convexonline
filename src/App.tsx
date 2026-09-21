import { useEffect, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { SignIn } from "./components/SignIn";
import { CreateInn } from "./components/CreateInn";
import { Workspace } from "./components/Workspace";
import { describeError } from "./errors";

export default function App() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <main className="shell shell-center">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!isAuthenticated) return <SignIn />;
  return <Authenticated />;
}

function Authenticated() {
  const viewer = useQuery(api.users.viewer);
  const inns = useQuery(api.inns.mine);
  const enterDemo = useMutation(api.demo.enter);
  const { signOut } = useAuthActions();
  const [chosenInnId, setInnId] = useState<Id<"inns"> | null>(null);
  const innId = chosenInnId ?? inns?.[0]?.innId ?? null;
  const [error, setError] = useState<string | null>(null);

  const isAnonymous = viewer?.isAnonymous === true;
  const needsDemo = isAnonymous && inns !== undefined && inns.length === 0;

  useEffect(() => {
    if (!needsDemo) return;
    let cancelled = false;
    enterDemo({})
      .then((id) => {
        if (!cancelled) setInnId(id);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [needsDemo, enterDemo]);


  if (viewer === undefined || inns === undefined) {
    return (
      <main className="shell shell-center">
        <p className="muted">Loading your workspace…</p>
      </main>
    );
  }

  const header = (
    <header className="topbar">
      <div className="row">
        <strong>Front Desk</strong>
        {inns.length > 1 && (
          <select value={innId ?? ""} onChange={(e) => setInnId(e.target.value as Id<"inns">)}>
            {inns.map((inn) => (
              <option key={inn.innId} value={inn.innId}>
                {inn.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="row">
        <span className="muted">{viewer?.name ?? viewer?.email ?? "Signed in"}</span>
        <button onClick={() => void signOut()}>Sign out</button>
      </div>
    </header>
  );

  if (error) {
    return (
      <main className="shell">
        {header}
        <p className="error">{error}</p>
      </main>
    );
  }

  if (inns.length === 0) {
    if (isAnonymous) {
      return (
        <main className="shell">
          {header}
          <p className="muted">Preparing your demo inn…</p>
        </main>
      );
    }
    return (
      <main className="shell">
        {header}
        <CreateInn onCreated={setInnId} />
      </main>
    );
  }

  if (!innId) return null;
  return (
    <main className="shell">
      {header}
      <Workspace innId={innId} />
    </main>
  );
}
