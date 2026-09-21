import type { ReactNode } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import type { Id } from "../../../convex/_generated/dataModel";
import type { InnSummary, Viewer, WorkspaceView } from "../types";
import { Mark } from "../lib/Mark";

export type ShellProps = {
  viewer: Viewer;
  inns: InnSummary[];
  currentInn: InnSummary;
  onSwitchInn: (innId: Id<"inns">) => void;
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  correctionsCount: number | undefined;
  isDemo: boolean;
  header: ReactNode;
  children: ReactNode;
  flush?: boolean;
};

const NAV: { key: WorkspaceView; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "corrections", label: "Policy changes" },
  { key: "knowledge", label: "Knowledge" },
];

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function Shell(props: ShellProps) {
  const { signOut } = useAuthActions();
  const { viewer, inns, currentInn, view, onNavigate, correctionsCount, isDemo } = props;
  const displayName = viewer.isAnonymous ? "Demo visitor" : viewer.name ?? viewer.email ?? "Staff";

  return (
    <div className="fd-shell">
      <nav className="fd-rail" aria-label="Workspace">
        <div className="fd-rail__brand">
          <Mark />
          <span>Front Desk</span>
        </div>

        <div className="fd-rail__property">
          <div className="fd-rail__property-label">Property</div>
          {inns.length > 1 ? (
            <>
              <span className="fd-sr-only" id="fd-inn-switch-label">
                Switch property
              </span>
              <select
                aria-labelledby="fd-inn-switch-label"
                value={currentInn.innId}
                onChange={(e) => props.onSwitchInn(e.target.value as Id<"inns">)}
              >
                {inns.map((inn) => (
                  <option key={inn.innId} value={inn.innId}>
                    {inn.name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <div className="fd-rail__property-name">{currentInn.name}</div>
          )}
        </div>

        <div className="fd-rail__nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              className="fd-rail__item"
              aria-current={view === item.key ? "page" : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span>{item.label}</span>
              {item.key === "corrections" ? (
                <span
                  className={`fd-rail__count${correctionsCount ? "" : " fd-rail__count--zero"}`}
                  aria-label={
                    correctionsCount === undefined
                      ? "loading"
                      : correctionsCount === 1
                        ? "1 reply needs review"
                        : `${correctionsCount} replies need review`
                  }
                >
                  {correctionsCount === undefined ? "…" : correctionsCount}
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            className="fd-rail__item"
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => onNavigate("settings")}
          >
            <span>Settings</span>
          </button>
        </div>

        <div className="fd-rail__footer">
          <div className="fd-rail__who">
            <span className="fd-avatar" aria-hidden="true">
              {initials(displayName, viewer.email)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="fd-rail__who-name">{displayName}</span>
              <span className="fd-rail__who-role">
                {currentInn.role === "demo" ? "demo access" : currentInn.role}
              </span>
            </span>
          </div>
          {isDemo ? <div className="fd-rail__demo">Demo workspace · no real email is sent</div> : null}
          <button type="button" className="fd-btn fd-btn--small" onClick={() => void signOut()}>
            {viewer.isAnonymous ? "Leave demo" : "Sign out"}
          </button>
        </div>
      </nav>

      <div className="fd-main">
        <header className="fd-header">{props.header}</header>
        <main className={`fd-body${props.flush ? " fd-body--flush" : ""}`}>{props.children}</main>
      </div>
    </div>
  );
}

export function HeaderTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <h1 className="fd-header__title">{title}</h1>
      {sub ? <p className="fd-header__sub">{sub}</p> : null}
    </div>
  );
}
