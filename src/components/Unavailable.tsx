/** Rendered instead of the app when VITE_CONVEX_URL is missing at build time. */
export function Unavailable() {
  return (
    <main
      style={{
        maxWidth: 420,
        margin: "10vh auto 0",
        padding: 16,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        color: "#183c3a",
      }}
    >
      <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Front Desk</h1>
      <p>This deployment is not configured yet (missing Convex URL). Please check back shortly.</p>
    </main>
  );
}
