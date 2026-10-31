"use client";

import { useEffect, useRef, useState } from "react";

const DUR = "2.6s";
const RINGS = [
  { r: 44, width: 7, dash: "152.1 276.5", opacity: 1, turn: 540 },
  { r: 33, width: 6, dash: "103.7 207.3", opacity: 0.8, turn: -480 },
  { r: 22, width: 5, dash: "62.2 138.2", opacity: 0.6, turn: 600 },
];

/**
 * The orange check of the contact buttons' "done" badge (the owner's orange-check-loop.svg, inline: three rings spin in
 * and shrink, then the check draws itself; loops every 2.6 s). Mounted fresh on every appearance, and its clock set back
 * to 0, so it always starts from the beginning. Decorative: the button's text says what happened. With reduced motion
 * the check is shown still (no rings, no drawing).
 */
export function CheckLoop({ size = 19 }: { size?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [still] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => {
    try {
      ref.current?.setCurrentTime(0);
    } catch {
      // older engines: the fresh element already starts at 0
    }
  }, []);
  if (still)
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false" data-check-still>
        <path d="M24 52 L42 70 L77 32" fill="none" stroke="#F57C20" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg ref={ref} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
      <g transform="translate(50 50)">
        <g>
          <animateTransform attributeName="transform" type="scale" values="1;0.15;0.15;1" keyTimes="0;0.288;0.885;1" dur={DUR} repeatCount="indefinite" />
          <g transform="translate(-50 -50)">
            {RINGS.map((ring) => (
              <g key={ring.r} opacity="0">
                <animate attributeName="opacity" values="0;1;1;0;0;0" keyTimes="0;0.038;0.250;0.308;0.885;1" dur={DUR} repeatCount="indefinite" />
                <circle
                  cx="50"
                  cy="50"
                  r={ring.r}
                  fill="none"
                  stroke="#F57C20"
                  strokeWidth={ring.width}
                  strokeLinecap="round"
                  strokeDasharray={ring.dash}
                  opacity={ring.opacity}
                >
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    values={`0 50 50;${ring.turn} 50 50;${ring.turn} 50 50`}
                    keyTimes="0;0.288;1"
                    dur={DUR}
                    repeatCount="indefinite"
                  />
                </circle>
              </g>
            ))}
          </g>
        </g>
      </g>
      <path
        d="M24 52 L42 70 L77 32"
        fill="none"
        stroke="#F57C20"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        strokeDasharray="100"
        strokeDashoffset="100"
        opacity="0"
      >
        <animate
          attributeName="stroke-dashoffset"
          values="100;100;0;0;100;100"
          keyTimes="0;0.269;0.423;0.808;0.904;1"
          dur={DUR}
          repeatCount="indefinite"
          calcMode="spline"
          keySplines="0.4 0 0.2 1;0.4 0 0.2 1;0.4 0 0.2 1;0.4 0 0.2 1;0.4 0 0.2 1"
        />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.262;0.904;1" dur={DUR} repeatCount="indefinite" />
      </path>
    </svg>
  );
}
