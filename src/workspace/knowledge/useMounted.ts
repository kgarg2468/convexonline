import { useEffect, useState } from "react";

/**
 * False until the browser has painted the first commit made while `active`,
 * true from then on. Lists put it on a `data-mounted` attribute so their rows'
 * `@starting-style` enter transition (styles.ts `rowEnterClass`) runs only for
 * rows added after that paint. `active` lets a view that shows a spinner
 * first count from the render that has its data, not from its own mount. The
 * flip waits for an animation frame: React flushes effects before paint when
 * the render came from a click (the rail), and an attribute set before the
 * rows' first style would let them animate anyway.
 */
export function useMounted(active = true): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return mounted;
}
