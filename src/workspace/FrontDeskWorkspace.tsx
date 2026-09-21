import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Correction, InnDetail, InnSummary, RecordVersionResult, ThreadStats, Viewer, WorkspaceView } from "./types";
import { AuthView } from "./auth/AuthView";
import { InnPicker } from "./onboarding/InnPicker";
import { Shell, HeaderTitle } from "./shell/Shell";
import { DemoActions } from "./shell/DemoActions";
import { CorrectionsView } from "./corrections/CorrectionsView";
import { InboxView } from "./inbox/InboxView";
import { KnowledgeView } from "./knowledge/KnowledgeView";
import { SettingsView } from "./settings/SettingsView";
import { Notice, Spinner } from "./lib/ui";
import { errorMessage } from "./lib/format";
import { useStoredState } from "./lib/hooks";
import "./workspace.css";

const INN_KEY = "frontdesk.innId";
export const STALL_AFTER_MS = 20_000;

/** True once `pending` has been continuously true for STALL_AFTER_MS; never fakes success. */
function useStalled(pending: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const id = window.setTimeout(() => setStalled(true), STALL_AFTER_MS);
    return () => {
      window.clearTimeout(id);
      setStalled(false);
    };
  }, [pending]);
  return stalled && pending;
}

/**
 * Root of the staff workspace. Render inside <ConvexAuthProvider>.
 * Decides between: signed out → AuthView; anonymous → seed and open the demo
 * inn; staff with no inn → onboarding; otherwise the shell with the chosen inn.
 */
export function FrontDeskWorkspace() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : "skip") as Viewer | null | undefined;
  const pending = isLoading || (isAuthenticated && viewer === undefined);
  const stalled = useStalled(pending);

  if (pending) {
    return (
      <div className="fd-root fd-center">
        <div className="fd-center__panel">
          <Spinner label="Opening Front Desk" />
          {stalled ? (
            <div style={{ marginTop: 14 }}>
              <Notice tone="caution">
                Still connecting after {STALL_AFTER_MS / 1000} seconds. The workspace could not confirm your session with the
                server.{" "}
                <button type="button" className="fd-btn fd-btn--small" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </Notice>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  if (!isAuthenticated || viewer === null || viewer === undefined) {
    return (
      <div className="fd-root">
        <AuthView />
      </div>
    );
  }
  return (
    <div className="fd-root">
      <SignedIn viewer={viewer} />
    </div>
  );
}

function SignedIn({ viewer }: { viewer: Viewer }) {
  const inns = useQuery(api.inns.mine, {}) as InnSummary[] | undefined;
  const enterDemo = useMutation(api.demo.enter);
  const [storedInn, setStoredInn] = useStoredState<string>(INN_KEY, "");
  const [demoError, setDemoError] = useState<string | null>(null);
  const seeding = useRef(false);

  // Anonymous visitors get their private demo inn seeded once, idempotently.
  const needsDemo = viewer.isAnonymous && inns !== undefined && !inns.some((i) => i.isDemo);
  useEffect(() => {
    if (!needsDemo || seeding.current) return;
    seeding.current = true;
    enterDemo({})
      .then((innId) => setStoredInn(innId as string))
      .catch((e) => setDemoError(errorMessage(e)))
      .finally(() => {
        seeding.current = false;
      });
  }, [needsDemo, enterDemo, setStoredInn]);

  const current = useMemo(() => {
    if (!inns) return null;
    return inns.find((i) => i.innId === storedInn) ?? (inns.length === 1 ? inns[0]! : null);
  }, [inns, storedInn]);

  if (inns === undefined) return <Spinner label="Loading your properties" />;

  if (viewer.isAnonymous) {
    if (demoError) {
      return (
        <div className="fd-center">
          <div className="fd-center__panel">
            <Notice tone="error">Could not open the demo. {demoError}</Notice>
          </div>
        </div>
      );
    }
    const demoInn = current?.isDemo ? current : inns.find((i) => i.isDemo);
    if (!demoInn) {
      return (
        <div className="fd-center">
          <Spinner label="Setting up your demo inn" />
        </div>
      );
    }
    return <Workspace key={demoInn.innId} viewer={viewer} inns={inns} current={demoInn} onSwitchInn={setStoredInn} />;
  }

  if (!current) {
    return <InnPicker viewer={viewer} inns={inns} onSelect={(id) => setStoredInn(id)} />;
  }
  return <Workspace key={current.innId} viewer={viewer} inns={inns} current={current} onSwitchInn={setStoredInn} />;
}

function Workspace({
  viewer,
  inns,
  current,
  onSwitchInn,
}: {
  viewer: Viewer;
  inns: InnSummary[];
  current: InnSummary;
  onSwitchInn: (innId: string) => void;
}) {
  const innId = current.innId;
  const detail = useQuery(api.inns.get, { innId }) as InnDetail | undefined;
  const openCorrections = useQuery(api.corrections.list, { innId, status: "needs_review" }) as
    | Correction[]
    | undefined;
  const stats = useQuery(api.threads.stats, { innId }) as ThreadStats | undefined;
  // Judges land on the policy-change review; staff land on the inbox.
  const [view, setView] = useState<WorkspaceView>(current.isDemo ? "corrections" : "inbox");
  const [selectedThread, setSelectedThread] = useState<Id<"threads"> | null>(null);
  // Result of the last scripted demo page edit. Held here so the sentence
  // stays on screen when the review zero-state hero gives way to the cards.
  const [lastDemoChange, setLastDemoChange] = useState<RecordVersionResult | null>(null);

  function openThread(threadId: Id<"threads">) {
    setSelectedThread(threadId);
    setView("inbox");
  }

  const header = (() => {
    switch (view) {
      case "corrections":
        return (
          <>
            <HeaderTitle title="Policy changes" sub="See which replies need a second look" />
            <div className="fd-header__actions">
              <button type="button" className="fd-btn" onClick={() => setView("inbox")}>
                Go to inbox
              </button>
            </div>
          </>
        );
      case "inbox":
        return (
          <>
            <HeaderTitle
              title="Inbox"
              sub={
                stats
                  ? `${stats.open} open · ${stats.needsStaff} need you · ${stats.ready} ready · ${stats.sentToday} sent today`
                  : detail?.inn.inboxAddress ?? (current.isDemo ? "Seeded guest threads" : "No inbox set up yet")
              }
            />
            <div className="fd-header__actions">
              {current.isDemo ? (
                <DemoActions
                  innId={innId}
                  last={lastDemoChange}
                  onResult={(r) => {
                    setLastDemoChange(r);
                    setView("corrections");
                  }}
                />
              ) : null}
            </div>
          </>
        );
      case "knowledge":
        return <HeaderTitle title="Knowledge" sub={current.siteUrl} />;
      case "settings":
        return <HeaderTitle title="Settings" />;
    }
  })();

  return (
    <Shell
      viewer={viewer}
      inns={inns}
      currentInn={current}
      onSwitchInn={onSwitchInn}
      view={view}
      onNavigate={setView}
      correctionsCount={openCorrections?.length}
      isDemo={current.isDemo}
      header={header}
      flush={view === "inbox"}
    >
      {view === "corrections" ? (
        <CorrectionsView
          innId={innId}
          viewerId={viewer._id}
          isDemo={current.isDemo}
          liveMail={detail?.liveMail}
          lastDemoChange={lastDemoChange}
          onDemoChange={setLastDemoChange}
          onOpenThread={openThread}
        />
      ) : view === "inbox" ? (
        <InboxView
          innId={innId}
          viewerId={viewer._id}
          isDemo={current.isDemo}
          liveMail={detail?.liveMail}
          selected={selectedThread}
          onSelect={setSelectedThread}
          onOpenCorrections={() => setView("corrections")}
        />
      ) : view === "knowledge" ? (
        <KnowledgeView innId={innId} siteUrl={current.siteUrl} isDemo={current.isDemo} />
      ) : detail === undefined ? (
        <Spinner label="Loading property" />
      ) : (
        <SettingsView viewer={viewer} detail={detail} />
      )}
    </Shell>
  );
}
