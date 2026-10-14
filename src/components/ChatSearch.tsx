"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  answerForHistory,
  CARDS_SHOWN,
  type ChatCard,
  type ChatResults,
  type ChatShop,
  type ChatStep,
  type ChatTurn,
  MAX_QUESTION,
  readEvents,
} from "@/lib/chatProtocol";
import type { StatusLabels } from "@/lib/hours";
import { LiveStatus } from "./ShopStatus";

// The map loads only when "Ukázať na mape" is opened (MapLibre is the heaviest script on the site).
const ShopMap = dynamic(() => import("./ShopMap").then((m) => m.ShopMap), { ssr: false });

export interface ChatLabels {
  headline: string;
  placeholder: string;
  follow_up: string;
  send: string;
  stop: string;
  new_chat: string;
  examples: string[];
  examples_label: string;
  you: string;
  assistant: string;
  step_understand: string;
  step_search: string;
  step_verify: string;
  fallback_note: string;
  limited: string;
  unavailable: string;
  nothing_found: string;
  searched: string;
  stopped: string;
  error: string;
  show_more: string;
  show_map: string;
  hide_map: string;
  ai_note: string;
  results: string;
  map: string;
  keyboard_hint: string;
}

interface Turn {
  id: number;
  question: string;
  answer: string;
  language: string | null;
  step: ChatStep | null;
  state: "running" | "done" | "stopped" | "error";
  results: ChatResults | null;
  fallback: { limited: boolean; reason?: string } | null;
}

/** No event at all for this long: the connection is gone; the plain search instead. */
const STALL_MS = 15_000;

/**
 * The main page's search (Prompt 10): one chat input in the middle of an empty page; after the
 * first question the input moves to the bottom and the conversation shows above it. Answers
 * stream from /api/ai-search with the real steps of the request; the cards come from the server
 * (search results only). The conversation lives only in this tab: the last few turns go along
 * with each question, nothing is stored. Without JavaScript the form still works: it opens
 * /[lang]?q=… with the plain results in the first HTML (children); with JavaScript such a link
 * starts the chat with its question. Never asks for or guesses the visitor's location.
 */
export function ChatSearch({
  lang,
  labels,
  statusLabels,
  initialQuestion,
  children,
}: {
  lang: string;
  labels: ChatLabels;
  statusLabels: StatusLabels;
  initialQuestion: string | null;
  /** The server-rendered plain results of ?q= (for crawlers, shared links and no JavaScript). */
  children?: ReactNode;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  // The server's plain results of ?q= stay until the chat starts (always, without JavaScript).
  const [serverResults, setServerResults] = useState(Boolean(initialQuestion));
  const running = turns.some((turn) => turn.state === "running");
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const box = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const startedOnce = useRef(false);

  const update = useCallback((id: number, change: (turn: Turn) => Partial<Turn>) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, ...change(turn) } : turn)));
  }, []);

  /** Reads the NDJSON answer of one request into the turn; false when the connection broke. */
  const stream = useCallback(
    async (id: number, body: Record<string, unknown>, abort: AbortController): Promise<"ok" | "stalled" | "aborted" | "failed"> => {
      let stalled = false;
      let timer = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, STALL_MS);
      try {
        const res = await fetch("/api/ai-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) return "failed";
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          clearTimeout(timer);
          timer = setTimeout(() => {
            stalled = true;
            abort.abort();
          }, STALL_MS);
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = readEvents(buffer);
          buffer = rest;
          for (const event of events) {
            if (event.type === "step") update(id, () => ({ step: event.step }));
            else if (event.type === "language") update(id, () => ({ language: event.language }));
            else if (event.type === "text") update(id, (turn) => ({ answer: turn.answer + event.text }));
            else if (event.type === "reset") update(id, () => ({ answer: "" }));
            else if (event.type === "results") update(id, () => ({ results: { cards: event.cards, shops: event.shops, searched: event.searched } }));
            else if (event.type === "fallback") {
              update(id, () => ({
                answer: "",
                results: { cards: event.cards, shops: event.shops, searched: event.searched },
                fallback: { limited: event.limited, ...(event.reason ? { reason: event.reason } : {}) },
              }));
            } else if (event.type === "done") update(id, () => ({ state: "done", step: null }));
          }
        }
        return "ok";
      } catch {
        return stalled ? "stalled" : abort.signal.aborted ? "aborted" : "failed";
      } finally {
        clearTimeout(timer);
      }
    },
    [update],
  );

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim().slice(0, MAX_QUESTION);
      if (question.length < 2 || turns.some((turn) => turn.state === "running")) return;
      setServerResults(false);
      setInput("");
      const id = nextId.current++;
      // The last few turns, text only, so a follow-up keeps its context (the server stores nothing).
      const history: ChatTurn[] = turns
        .filter((turn) => turn.state === "done")
        .slice(-3)
        .flatMap((turn) => [
          { role: "user" as const, text: turn.question },
          { role: "assistant" as const, text: answerForHistory(turn.answer || "(plain search results)", turn.results?.cards ?? []) },
        ]);
      setTurns((all) => [
        ...all,
        { id, question, answer: "", language: null, step: "understand", state: "running", results: null, fallback: null },
      ]);
      try {
        window.history.replaceState(window.history.state, "", `/${lang}?${new URLSearchParams({ q: question })}`);
      } catch {
        // the address simply stays
      }
      const abort = new AbortController();
      controller.current = abort;
      let outcome = await stream(id, { q: question, lang, history }, abort);
      if (outcome === "stalled" || outcome === "failed") {
        // The answer did not arrive: the plain database search, in the same chat format.
        const retry = new AbortController();
        controller.current = retry;
        update(id, () => ({ answer: "", step: "search" }));
        outcome = await stream(id, { q: question, lang, plain: true }, retry);
      }
      controller.current = null;
      if (outcome === "aborted") update(id, (turn) => (turn.state === "running" ? { state: "stopped", step: null } : {}));
      else if (outcome !== "ok") update(id, () => ({ state: "error", step: null }));
      else update(id, (turn) => (turn.state === "running" ? { state: "done", step: null } : {}));
    },
    [lang, stream, turns, update],
  );

  /** "Zastaviť" / Esc: the request is cancelled, and the server stops the AI call with it. */
  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);

  const newChat = useCallback(() => {
    stop();
    setTurns([]);
    setServerResults(false);
    setInput("");
    try {
      window.history.replaceState(window.history.state, "", `/${lang}`);
    } catch {
      // the address simply stays
    }
    setTimeout(() => box.current?.focus(), 0);
  }, [lang, stop]);

  // A shared link /[lang]?q=…: the chat starts with its question.
  useEffect(() => {
    if (!initialQuestion || startedOnce.current) return;
    startedOnce.current = true;
    const start = setTimeout(() => void ask(initialQuestion), 0);
    return () => clearTimeout(start);
  }, [initialQuestion, ask]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && controller.current) {
        event.preventDefault();
        stop();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [stop]);

  // The newest words stay in view while the answer streams (unless the shopper scrolled up).
  const last = turns[turns.length - 1];
  useEffect(() => {
    if (!last) return;
    const rect = bottom.current?.getBoundingClientRect();
    if (rect && rect.top - window.innerHeight < 240) bottom.current?.scrollIntoView({ block: "end" });
  }, [last?.answer, last?.results, last?.step, last]);

  // The box grows with the text (up to about eight lines).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const chat = turns.length > 0 || serverResults;

  const form = (
    <form
      action={`/${lang}`}
      method="get"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        void ask(input);
      }}
      className="w-full"
      data-chat-form
    >
      <div className="flex items-end gap-2 rounded-3xl border border-line bg-white p-2 pl-4 shadow-sm focus-within:border-foreground">
        <textarea
          ref={box}
          name="q"
          rows={1}
          value={input}
          maxLength={MAX_QUESTION}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(input);
            }
          }}
          placeholder={chat ? labels.follow_up : labels.placeholder}
          aria-label={labels.placeholder}
          aria-describedby="chat-keys"
          enterKeyHint="send"
          autoFocus={!initialQuestion}
          className="max-h-56 min-h-10 flex-1 resize-none bg-transparent py-2 text-base outline-none placeholder:text-muted"
          data-chat-input
        />
        {running ? (
          <button
            type="button"
            onClick={stop}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-foreground px-3 text-sm font-medium"
            data-chat-stop
          >
            <span aria-hidden className="inline-block h-2.5 w-2.5 bg-foreground" />
            {labels.stop}
          </button>
        ) : (
          <button
            type="submit"
            aria-label={labels.send}
            disabled={input.trim().length < 2}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-foreground text-white disabled:bg-line disabled:text-muted"
            data-chat-send
          >
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
      <p id="chat-keys" className="sr-only">
        {labels.keyboard_hint}
      </p>
    </form>
  );

  if (!chat) {
    // Empty state: logo, headline, one input and a few examples in the middle; nothing else.
    return (
      <div className="flex min-h-[calc(100dvh-8.5rem)] flex-col items-center justify-center gap-6 py-6" data-chat-empty>
        {/* eslint-disable-next-line @next/next/no-img-element -- small static logo, exact size given */}
        <img src="/brand/cacadoo-pin.png" alt="" width={32} height={48} className="h-12 w-auto" />
        <h1 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">{labels.headline}</h1>
        <div className="w-full max-w-2xl">{form}</div>
        <ul className="flex max-w-2xl flex-wrap justify-center gap-2" aria-label={labels.examples_label}>
          {labels.examples.map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => {
                  setInput(example);
                  box.current?.focus();
                }}
                className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-foreground"
                data-chat-example
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col" data-chat>
      <div className="flex justify-end pb-2">
        <button type="button" onClick={newChat} className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm hover:border-foreground" data-new-chat>
          <span aria-hidden>+</span> {labels.new_chat}
        </button>
      </div>
      <ol className="flex flex-col gap-8 pb-6" aria-label={labels.results}>
        {serverResults && initialQuestion && (
          // Before the chat starts (and without JavaScript): the question and the plain results from the server.
          <li className="flex flex-col gap-4">
            <Question text={initialQuestion} label={labels.you} />
            <div>{children}</div>
          </li>
        )}
        {turns.map((turn) => (
          <li key={turn.id} className="flex flex-col gap-4" data-turn={turn.state}>
            <Question text={turn.question} label={labels.you} />
            <Answer turn={turn} labels={labels} statusLabels={statusLabels} lang={lang} />
          </li>
        ))}
      </ol>
      <div ref={bottom} />
      <div className="sticky bottom-0 bg-white pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)]" data-chat-dock>
        {form}
      </div>
    </div>
  );
}

function Question({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-100 px-4 py-2" aria-label={label} data-chat-question>
        {text}
      </p>
    </div>
  );
}

/** "Rozumiem otázke…" with three soft dots in Cacadoo yellow next to the small pin (static with reduced motion). */
function Thinking({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2" data-thinking>
      {/* eslint-disable-next-line @next/next/no-img-element -- small static icon, exact size given */}
      <img src="/brand/cacadoo-pin.png" alt="" width={13} height={20} className="h-5 w-auto" />
      <span className="ppi-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="text-sm text-muted" data-thinking-step>
        {text}
      </span>
    </div>
  );
}

function Skeletons() {
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line" aria-hidden data-card-skeletons>
      {[0, 1, 2].map((n) => (
        <li key={n} className="flex flex-col gap-2 py-3">
          <span className="ppi-skeleton h-4 w-2/3" />
          <span className="ppi-skeleton h-3 w-1/2" />
          <span className="ppi-skeleton h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

function Answer({ turn, labels, statusLabels, lang }: { turn: Turn; labels: ChatLabels; statusLabels: StatusLabels; lang: string }) {
  const [more, setMore] = useState(false);
  const [map, setMap] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  const stepText = turn.step === "search" ? labels.step_search : turn.step === "verify" ? labels.step_verify : labels.step_understand;
  const cards = turn.results?.cards ?? [];
  const shown = more ? cards : cards.slice(0, CARDS_SHOWN);
  const waitingCards = turn.state === "running" && !turn.results && (turn.step === "search" || turn.step === "verify" || turn.answer);
  const pins = Object.entries(turn.results?.shops ?? {}).filter(([, shop]) => shop.lat !== null && shop.lng !== null);

  return (
    <div className="flex flex-col gap-3" aria-label={labels.assistant}>
      <div aria-live="polite" aria-busy={turn.state === "running"} className="flex flex-col gap-2">
        {turn.state === "running" && !turn.answer && !turn.results && <Thinking text={stepText} />}
        {turn.answer && (
          <p className="whitespace-pre-wrap leading-relaxed" lang={turn.language ?? undefined} data-chat-answer>
            {turn.answer}
          </p>
        )}
        {turn.fallback && (
          <p className="text-sm text-muted" data-fallback-note>
            {labels.fallback_note}
            {turn.fallback.limited && <span className="block">{labels.limited}</span>}
            {turn.fallback.reason && <span className="block">{labels.unavailable.replace("{reason}", turn.fallback.reason)}</span>}
          </p>
        )}
        {turn.state === "stopped" && <p className="text-sm text-muted">{labels.stopped}</p>}
        {turn.state === "error" && <p className="text-sm">{labels.error}</p>}
      </div>

      {waitingCards && <Skeletons />}

      {turn.results && cards.length === 0 && (turn.state !== "running" || turn.fallback) && (
        <div className="text-sm" data-nothing-found>
          {!turn.answer && <p>{labels.nothing_found}</p>}
          {turn.results.searched.length > 0 && <p className="text-muted">{labels.searched.replace("{terms}", turn.results.searched.join(", "))}</p>}
        </div>
      )}

      {cards.length > 0 && (
        <>
          <ul className="flex flex-col divide-y divide-line border-y border-line" data-chat-cards>
            {shown.map((card) => (
              <Card key={card.id} card={card} shop={turn.results!.shops[card.shopSlug]} statusLabels={statusLabels} lang={lang} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {cards.length > shown.length && (
              <button type="button" onClick={() => setMore(true)} className="underline underline-offset-4" data-show-more>
                {labels.show_more} ({cards.length - shown.length})
              </button>
            )}
            {pins.length > 0 && (
              <button type="button" onClick={() => setMap((open) => !open)} aria-expanded={map} className="underline underline-offset-4" data-show-map>
                {map ? labels.hide_map : labels.show_map}
              </button>
            )}
            {!turn.fallback && <span className="text-xs text-muted">{labels.ai_note}</span>}
          </div>
          {map && (
            <ShopMap
              shops={pins.map(([slug, shop]) => ({ slug, name: shop.name, lat: shop.lat!, lng: shop.lng!, href: shop.href, status: shop.status }))}
              label={labels.map}
              statusLabels={statusLabels}
              renderedAt={renderedAt}
              className="h-56 md:h-72"
            />
          )}
        </>
      )}
    </div>
  );
}

function Card({ card, shop, statusLabels, lang }: { card: ChatCard; shop: ChatShop | undefined; statusLabels: StatusLabels; lang: string }) {
  const [renderedAt] = useState(() => Date.now());
  return (
    <li className="flex flex-col gap-1 py-3" data-card data-shop={card.shopSlug}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <a href={card.href} className="font-medium hover:underline" data-card-item>
            {card.name}
          </a>
          {card.translated && (
            <p className="text-sm text-muted" lang={card.translatedLang ?? undefined}>
              {card.translated}
            </p>
          )}
        </div>
        <span className="whitespace-nowrap font-medium">{card.price}</span>
      </div>
      <div className="text-sm text-muted">
        {card.brand && `${card.brand} · `}
        <a href={card.shopHref} className="hover:underline" data-card-shop>
          {card.shop}
        </a>
        {card.place && ` · ${card.place}`}
        {card.distance && <span data-card-distance>{` · ${card.distance}`}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {card.availability && <span className="font-semibold">{card.availability}</span>}
        <span className="rounded border border-line px-1.5 text-xs" data-freshness={card.freshnessState}>
          {card.freshness}
        </span>
        {shop && <LiveStatus input={shop.status} labels={statusLabels} lang={lang} renderedAt={renderedAt} />}
      </div>
    </li>
  );
}
