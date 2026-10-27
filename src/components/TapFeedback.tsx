"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/** A form sent to a server action (React marks it with $ACTION_ fields, or a javascript: action after hydration). */
function isActionForm(form: HTMLFormElement) {
  return (form.getAttribute("action") ?? "").startsWith("javascript:") || Boolean(form.querySelector('input[name^="$ACTION_"]'));
}

function clearAll() {
  for (const form of document.querySelectorAll<HTMLFormElement>("form[data-pending]")) {
    delete form.dataset.pending;
    form.querySelector("[aria-busy='true'][data-tap-busy]")?.removeAttribute("aria-busy");
    form.querySelector("[data-tap-busy]")?.removeAttribute("data-tap-busy");
  }
}

/**
 * Feedback at the first tap on every Môj obchod form (performance pass): a form sent to a server action is marked
 * data-pending at once (its button looks pressed and busy, globals.css) and a second tap does not send it again.
 * The mark goes when the page's address changes (the action's redirect), else after 15 s. Forms that send on their
 * own (the chats) are not touched. Mounted once in the root layout; renders nothing.
 */
export function TapFeedback() {
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    let timer = 0;
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !isActionForm(form)) return;
      if (form.dataset.pending) {
        // Already on its way: not twice.
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const submitter = event.submitter;
      // After React has read the form (a disabled or changed button would be left out of it).
      window.setTimeout(() => {
        form.dataset.pending = "1";
        if (submitter) {
          submitter.setAttribute("aria-busy", "true");
          submitter.setAttribute("data-tap-busy", "");
        }
      }, 0);
      window.clearTimeout(timer);
      timer = window.setTimeout(clearAll, 15_000);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      window.clearTimeout(timer);
    };
  }, []);

  // The action answered with a new address (?ok=… / ?err=…): the form can be sent again.
  useEffect(() => {
    clearAll();
  }, [pathname, search]);

  return null;
}
