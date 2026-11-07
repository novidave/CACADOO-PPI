import { useId } from "react";

/**
 * "Opraviť gramatiku"'s icon (2026-11-07, canvas "Cacaduu – webová aplikácia (Môj obchod)", artboards 8 / 8b): the
 * "star vortex" — three curved arms 120° apart (stroke 1.9, a #1D4ED8 → #60A5FA gradient), a small four-point star at
 * each arm's end and a bigger one in the middle (#2563EB). The motion lives in globals.css (`.ppi-gv`): the arms turn
 * slowly on hover (3 s), spin 720° in 0.95 s on a click with the middle star pulled in and popping back and the small
 * stars twinkling one after another; `data-busy` (the AI works) keeps them turning (0.9 s) and blinking; while turning
 * the icon runs through the rainbow (hue-rotate), at rest it is blue; nothing moves with prefers-reduced-motion. The
 * same icon on every "Opraviť gramatiku" (CRM reply, Správy, Šablóny, the blog editor's AI).
 */
export function GrammarVortex({ size = 24 }: { size?: number }) {
  const id = `gv${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const arm = (cls: string, rotate?: number) => (
    <g transform={rotate ? `rotate(${rotate} 12 12)` : undefined}>
      <path d="M12 6.6C16.6 4.6 21.3 7.6 21.2 12.8" />
      <path
        className={`ppi-gv-star ${cls}`}
        d="M21.2 14.2Q21.2 15.6 22.6 15.6Q21.2 15.6 21.2 17Q21.2 15.6 19.8 15.6Q21.2 15.6 21.2 14.2Z"
        fill="#2563EB"
        stroke="none"
      />
    </g>
  );
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" className="ppi-gv-svg" style={{ overflow: "visible" }} data-grammar-vortex>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1D4ED8" />
          <stop offset="1" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <g className="ppi-gv-arms" fill="none" stroke={`url(#${id})`} strokeWidth="1.9" strokeLinecap="round">
        {arm("a")}
        {arm("b", 120)}
        {arm("c", 240)}
      </g>
      <path
        className="ppi-gv-mid"
        d="M12 7.4C12.6 10.5 13.5 11.4 16.6 12C13.5 12.6 12.6 13.5 12 16.6C11.4 13.5 10.5 12.6 7.4 12C10.5 11.4 11.4 10.5 12 7.4Z"
        fill="#2563EB"
      />
    </svg>
  );
}
