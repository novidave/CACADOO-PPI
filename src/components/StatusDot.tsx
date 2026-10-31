import type { StatusState } from "@/lib/hours";
import { STATUS_COLORS } from "@/lib/statusColors";

/**
 * A status dot: the one colour on the site besides the logo, always next to the status in words
 * (never colour alone). White outline and a thin dark ring, so yellow and grey stay visible.
 */
export function StatusDot({ state, size = 10 }: { state: StatusState; size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-status-dot={state}
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: STATUS_COLORS[state],
        border: "2px solid #fff",
        boxShadow: "0 0 0 1px #171717",
        boxSizing: "content-box",
      }}
    />
  );
}
