import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import { Unavailable } from "./components/Unavailable";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;

const root = createRoot(document.getElementById("root")!);

// Fail closed: without a Convex URL there is nothing to talk to, so show a
// plain notice instead of a workspace that can never load.
if (!convexUrl) {
  root.render(<Unavailable />);
} else {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
