/**
 * The AI pomocník's conversation in the browser (2026-11-04): one store for the computer's side panel and the phone's
 * page, kept while the owner moves between pages (the panel lives in the account layout; the module stays loaded),
 * cleared by "Nová konverzácia" or when the shop changes. Nothing is stored on the server or in the browser's storage:
 * the last 8 turns go with each question.
 */

export interface ChatProposal {
  id: string;
  lines: string[];
  state: "waiting" | "busy" | "done" | "cancelled" | "error";
  note?: string;
}

export interface ChatMessage {
  id: number;
  role: "u" | "a";
  text: string;
  proposals?: ChatProposal[];
  links?: { title: string; link: string }[];
  sklad?: boolean;
  /** an error key of `pomocnik.*` (err_ai_off, err_ai_limit, err_no_plan, err_failed) or "stopped" */
  notice?: string;
}

export interface ChatState {
  shop: string | null;
  messages: ChatMessage[];
  busy: boolean;
  left: number | null;
}

const INITIAL: ChatState = { shop: null, messages: [], busy: false, left: null };
let state: ChatState = INITIAL;
let seq = 0;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

const emit = (next: ChatState) => {
  state = next;
  for (const l of listeners) l();
};

export const chatStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
  /** the server's first render: always empty */
  initial: (): ChatState => INITIAL,

  /** A new shop starts a new conversation. */
  setShop(shop: string) {
    if (state.shop !== shop) {
      controller?.abort();
      emit({ shop, messages: [], busy: false, left: null });
    }
  },

  clear() {
    controller?.abort();
    emit({ ...state, messages: [], busy: false });
  },

  stop() {
    controller?.abort();
  },

  async send(text: string, lang: string) {
    const q = text.trim();
    if (!q || state.busy || !state.shop) return;
    const history = state.messages.filter((m) => m.text && !m.notice).slice(-8).map((m) => ({ r: m.role, t: m.text.slice(0, 1000) }));
    const shop = state.shop;
    emit({ ...state, busy: true, messages: [...state.messages, { id: ++seq, role: "u", text: q }] });
    controller = new AbortController();
    let reply: ChatMessage;
    try {
      const res = await fetch("/api/owner/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, lang, text: q, history }),
        signal: controller.signal,
      });
      const out = (await res.json()) as {
        answer?: string;
        proposals?: { id: string; lines: string[] }[];
        links?: { title: string; link: string }[];
        sklad?: boolean;
        left?: number | null;
        stopped?: boolean;
        error?: string;
      };
      const proposals = (out.proposals ?? []).map((p) => ({ ...p, state: "waiting" as const }));
      reply = {
        id: ++seq,
        role: "a",
        text: out.answer ?? "",
        proposals,
        links: out.links ?? [],
        sklad: out.sklad,
        notice: out.stopped ? "stopped" : out.error ? `err_${out.error === "ai_off" || out.error === "ai_limit" || out.error === "no_plan" ? out.error : "failed"}` : undefined,
      };
      if (typeof out.left === "number") state = { ...state, left: out.left };
    } catch {
      reply = { id: ++seq, role: "a", text: "", notice: controller?.signal.aborted ? "stopped" : "err_failed" };
    }
    controller = null;
    if (state.shop !== shop) return;
    emit({ ...state, busy: false, messages: [...state.messages, reply] });
  },

  /** "Potvrdiť" / "Zrušiť" on a proposal card. */
  async decide(messageId: number, proposalId: string, action: "confirm" | "cancel", lang: string) {
    const set = (patch: Partial<ChatProposal>) =>
      emit({
        ...state,
        messages: state.messages.map((m) =>
          m.id !== messageId ? m : { ...m, proposals: (m.proposals ?? []).map((p) => (p.id === proposalId ? { ...p, ...patch } : p)) },
        ),
      });
    set({ state: "busy", note: undefined });
    try {
      const res = await fetch("/api/owner/assistant/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: proposalId, action, lang }),
      });
      const out = (await res.json()) as { ok?: boolean; error?: string; reason?: string };
      if (out.ok) set({ state: action === "cancel" ? "cancelled" : "done" });
      else set({ state: "error", note: out.error === "change" ? `change:${out.reason ?? ""}` : (out.error ?? "failed") });
    } catch {
      set({ state: "error", note: "failed" });
    }
  },
};
