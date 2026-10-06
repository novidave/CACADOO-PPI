import type { Dictionary } from "@/i18n/dictionaries";

const KEYS = ["credentials", "unconfirmed", "password", "mismatch", "link", "rate", "email", "config"] as const;

/** The message for ?error=… on the login, sign-up and password pages (unknown codes show nothing). */
export function authErrorText(dict: Dictionary, error: unknown, message?: unknown): string | null {
  if (error === "failed") return dict.login.error_failed.replace("{message}", typeof message === "string" ? message : "");
  const key = KEYS.find((k) => k === error);
  return key ? dict.login[`error_${key}`] : null;
}
