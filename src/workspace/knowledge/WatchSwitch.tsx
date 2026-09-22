import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * The "watched for changes" toggle on a page row. Built on the Radix Switch
 * primitive (already a dependency through `radix-ui`) because the project has
 * no shadcn `switch` component yet. The switch's accessible name is always
 * "Watched for changes" (the switch role carries on/off); the visible label
 * still shows the state in words, so the stacked phone row reads the same.
 */
export function WatchSwitch({
  id,
  checked,
  disabled,
  labelHidden,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  /** Show only the control from 901px (the table's "Watched" column names it). */
  labelHidden?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label="Watched for changes"
        onCheckedChange={onChange}
        className={cn(
          "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border-2 outline-hidden transition-colors duration-micro",
          "data-[state=checked]:bg-accent-9 focus-visible:ring-2 focus-visible:ring-accent-9 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50",
        )}
      >
        <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0.22_0.02_168/0.2)] transition-transform duration-micro ease-out data-[state=checked]:translate-x-[15px] motion-reduce:transition-none" />
      </SwitchPrimitive.Root>
      <label
        htmlFor={id}
        aria-hidden="true"
        className={cn("cursor-pointer text-[12px] leading-4 text-ink-3 select-none", disabled && "cursor-default", labelHidden && "min-[901px]:hidden")}
      >
        {checked ? "Watched for changes" : "Not watched"}
      </label>
    </span>
  );
}
