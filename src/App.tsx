import { LazyMotion, MotionConfig } from "motion/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FrontDeskWorkspace } from "./workspace";

/** Motion's layout/drag feature set, loaded on first use so it stays off the critical path. */
const loadMotionFeatures = () => import("./lib/motion-features").then((m) => m.default);

/** The staff workspace. main.tsx wraps this in ConvexAuthProvider. */
export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion strict features={loadMotionFeatures}>
        <TooltipProvider delayDuration={300}>
          <FrontDeskWorkspace />
          <Toaster position="bottom-right" visibleToasts={3} />
        </TooltipProvider>
      </LazyMotion>
    </MotionConfig>
  );
}
