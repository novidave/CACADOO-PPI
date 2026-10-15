"use client";

import type { ReactNode } from "react";

/** A submit button that asks first (window.confirm); without JavaScript it submits straight away. */
export function ConfirmButton({ children, question, className }: { children: ReactNode; question: string; className?: string }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(event) => {
        if (!window.confirm(question)) event.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
