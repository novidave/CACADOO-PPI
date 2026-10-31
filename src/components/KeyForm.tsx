"use client";

import { useId, useState } from "react";

export type KeyPhase = "idle" | "busy" | "ok";

/** The Cacaduu vortex: orange rings spin while the key is checked; on success the white cockatoo head pops in with its
 * yellow crest, then an orange badge with a white check. Nothing before the check starts. Decorative. */
export function KeyVortex({ phase }: { phase: KeyPhase }) {
  if (phase === "idle") return null;
  return (
    <svg className="ppi-vx" data-vx={phase} viewBox="0 0 100 100" width="30" height="30" aria-hidden="true" focusable="false">
      <g className="ppi-vx-rings">
        <circle className="ppi-vx-r1" cx="50" cy="50" r="44" fill="none" stroke="#F57C20" strokeWidth="7" strokeLinecap="round" strokeDasharray="152 277" />
        <circle className="ppi-vx-r2" cx="50" cy="50" r="34" fill="none" stroke="#F57C20" strokeWidth="6" strokeLinecap="round" strokeDasharray="104 214" opacity=".75" />
        <circle className="ppi-vx-r3" cx="50" cy="50" r="24" fill="none" stroke="#F57C20" strokeWidth="5" strokeLinecap="round" strokeDasharray="64 151" opacity=".5" />
      </g>
      <g className="ppi-vx-head">
        <g className="ppi-vx-crest">
          <path d="M44 34C40 22 31 13 22 10c7 6 13 14 16 25z" fill="#F5B70A" stroke="#B7860B" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M48 32C47 19 41 9 33 4c5 8 8 17 9 29z" fill="#FBC93D" stroke="#B7860B" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M53 32C55 21 52 11 46 5c3 8 3 17 1 28z" fill="#F5B70A" stroke="#B7860B" strokeWidth="1.5" strokeLinejoin="round" />
        </g>
        <path d="M28 60c0-15 10-27 24-27 13 0 22 10 22 23 0 14-10 25-24 25-12 0-22-9-22-21z" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="2.5" />
        <ellipse cx="54" cy="64" rx="7" ry="5" fill="#FDE68A" opacity=".8" />
        <circle cx="58" cy="51" r="4.2" fill="#1A1A1A" />
        <circle cx="59.4" cy="49.6" r="1.3" fill="#FFFFFF" />
        <path d="M68 52c7-1 13 4 13 11 0 4-2 7-5 8 0-4-2-7-6-7-2 0-4 1-5 2 0-6 1-11 3-14z" fill="#374151" stroke="#1A1A1A" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
      <g className="ppi-vx-badge">
        <circle cx="74" cy="76" r="14" fill="#F57C20" stroke="#FFFFFF" strokeWidth="3" />
        <path className="ppi-vx-check" d="M67 76l5 5 9-10" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/**
 * The key field and "Otvoriť" (a fixed 150 px button: its text on the left, a 30 px slot on the right for the vortex;
 * it never changes width). Enter in the field opens. An empty field says "Zadajte prístupový kľúč"; the shop's
 * answers (wrong key, too many tries) come in `problem`.
 */
export function KeyForm({
  phase,
  problem,
  onSubmit,
  labels,
}: {
  phase: KeyPhase;
  problem: string | null;
  onSubmit: (key: string) => void;
  labels: { key_hint: string; key_label: string; key_open: string; key_opening: string; key_done: string; key_empty: string; key_note: string };
}) {
  const [key, setKey] = useState("");
  const [empty, setEmpty] = useState(false);
  const field = useId();
  const error = useId();
  const shown = empty ? labels.key_empty : problem;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (phase !== "idle") return;
        const value = key.trim();
        if (!value) {
          setEmpty(true);
          (e.currentTarget.elements.namedItem("key") as HTMLInputElement | null)?.focus();
          return;
        }
        onSubmit(value);
        setKey("");
      }}
      className="flex flex-col"
      data-key-form
    >
      <p className="mb-2.5 text-[13.5px] leading-normal text-[#6E6E6E]">{labels.key_hint}</p>
      <div className="flex gap-[9px]">
        <label htmlFor={field} className="sr-only">
          {labels.key_label}
        </label>
        <input
          id={field}
          name="key"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setEmpty(false);
          }}
          placeholder={labels.key_label}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? error : undefined}
          className="ppi-key-input"
          data-key-input
        />
        <button type="submit" className="ppi-key-go" data-phase={phase} aria-live="polite" data-key-open>
          <span className="truncate text-left">{phase === "busy" ? labels.key_opening : phase === "ok" ? labels.key_done : labels.key_open}</span>
          <span className="block h-[30px] w-[30px]" aria-hidden="true">
            <KeyVortex phase={phase} />
          </span>
        </button>
      </div>
      {shown && (
        <p id={error} role="alert" className="mt-1.5 text-[13px] font-semibold text-[#DC2626]" data-key-problem>
          {shown}
        </p>
      )}
      <p className="mt-2 text-xs text-muted">{labels.key_note}</p>
    </form>
  );
}
