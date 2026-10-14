/**
 * The Claude model of every AI feature on the website (the main page's chat search and the shop
 * assistant): the server variable AI_MODEL; only when it is not set, this one default.
 */
export const DEFAULT_AI_MODEL = "claude-haiku-5-5";

export function aiModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
}
