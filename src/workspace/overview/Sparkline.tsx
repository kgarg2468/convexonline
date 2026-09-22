import { cn } from "@/lib/utils";

const W = 100;
const H = 32;
const PAD = 2;

/**
 * A 14-point sparkline (research-principles §135): 1.5px ink-3 stroke, no
 * axes, no fill, one dot on the last point. Decorative: the tile states the
 * numbers in an sr-only sentence. The path stretches to the tile's width
 * (`preserveAspectRatio="none"`); the dot is a positioned element so it stays
 * round. A flat series draws a flat line along the baseline. Nothing animates
 * on mount (charts never draw themselves in).
 */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const n = values.length;
  if (n === 0) return null;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const last = values[n - 1]!;
  return (
    <span aria-hidden="true" className={cn("relative block h-8 w-full text-ink-3", className)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-full w-full overflow-visible">
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        className="absolute right-0 size-1.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-current"
        style={{ top: `${(y(last) / H) * 100}%` }}
      />
    </span>
  );
}
