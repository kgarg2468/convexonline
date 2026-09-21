import type { ReactNode } from "react";

export function Notice({
  tone = "info",
  children,
  role,
}: {
  tone?: "info" | "caution" | "error" | "success";
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className={`fd-notice fd-notice--${tone}`} role={role ?? (tone === "error" ? "alert" : "status")}>
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="fd-loading" role="status" aria-live="polite">
      <span className="fd-loading__dot" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fd-empty">
      <p className="fd-empty__title">{title}</p>
      {children ? <p className="fd-empty__body">{children}</p> : null}
    </div>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "pine" | "caution" | "error" | "muted"; children: ReactNode }) {
  return <span className={`fd-pill fd-pill--${tone}`}>{children}</span>;
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="fd-field">
      <label className="fd-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <p className="fd-field__hint">{hint}</p> : null}
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="fd-link" href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}
