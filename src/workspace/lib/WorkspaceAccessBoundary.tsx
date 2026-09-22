import { Component, type ErrorInfo, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { Notice } from "./ui";
import { errorMessage } from "./format";

/**
 * Catches the render-time errors Convex's `useQuery` throws when a property's
 * private subscriptions are refused. That happens the moment an owner removes
 * a staff member: `inns.get`, `threads.stats` and the rest of the workspace
 * turn `forbidden` before the reactive `inns.mine` result arrives to unmount
 * the workspace. Access errors get a scoped, honest screen with a way back to
 * the property list; anything else is reported as the failure it is. Nothing
 * here ever renders the workspace as if access were still granted.
 */
type Props = { children: ReactNode; onReturn: () => void; returnLabel?: string };
type State = { error: unknown | null };

function isAccessError(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data = error.data as { code?: string } | string;
  if (typeof data === "string") return false;
  return data.code === "forbidden" || data.code === "unauthenticated" || data.code === "live_mail_forbidden";
}

export class WorkspaceAccessBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!isAccessError(error)) {
      // Real failures still reach the console; access changes are expected and do not.
      console.error("Workspace failed to render", error, info.componentStack);
    }
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const access = isAccessError(error);
    return (
      <div className="fd-center">
        <div className="fd-center__panel" role="region" aria-labelledby="fd-access-title">
          <h2 className="fd-h2" id="fd-access-title">
            {access ? "Your access to this property changed" : "The workspace could not be shown"}
          </h2>
          {access ? (
            <p className="fd-lede">
              This property is no longer available to your account. If you were expecting to keep working here, ask
              the owner for a new invitation.
            </p>
          ) : (
            <Notice tone="error">{errorMessage(error)}</Notice>
          )}
          <div className="fd-btn-row" style={{ marginTop: 16 }}>
            <button type="button" className="fd-btn fd-btn--primary" onClick={this.props.onReturn}>
              {this.props.returnLabel ?? "Back to properties"}
            </button>
            {access ? null : (
              <button type="button" className="fd-btn" onClick={() => window.location.reload()}>
                Reload
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
