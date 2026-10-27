import "./style.css";
import { messages, type en } from "./messages";
import type { Config } from "../core/model";
declare global {
  interface Window {
    connector: {
      settings: () => Promise<Config | null>;
      invoke: (action: string, value?: unknown) => Promise<State>;
      onState: (cb: (s: State) => void) => void;
    };
  }
}
type State = {
  message: string;
  configured: boolean;
  paired: boolean;
  secure: boolean;
  paused: boolean;
  busy: boolean;
  queued: number;
  lastTime: string | null;
  file: string | null;
  shop: string | null;
  source: string | null;
  validation?: { rows: number };
};
let lang: keyof typeof messages = "sk",
  state: State | undefined;
const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const keys = [
  "source_code",
  "name",
  "quantity",
  "price",
  "currency",
  "ean",
  "brand",
] as const;
for (const key of keys) {
  const label = document.createElement("label"),
    span = document.createElement("span"),
    field = document.createElement("input");
  span.dataset.t = key;
  field.id = "map-" + key;
  field.value = key;
  field.required = !["ean", "brand"].includes(key);
  label.append(span, field);
  $("mapping").append(label);
}
function translate() {
  document.documentElement.lang = lang;
  document
    .querySelectorAll<HTMLElement>("[data-t]")
    .forEach(
      (el) =>
        (el.textContent = messages[lang][el.dataset.t as keyof typeof en]),
    );
  if (state) render(state);
}
function render(s: State) {
  state = s;
  const m = messages[lang];
  $("status").textContent =
    m[s.message as keyof typeof en] ?? m.OPERATION_FAILED;
  $("details").textContent =
    `${m.source}: ${s.source ?? m.none} · ${s.file ?? m.none} · ${m.queued}: ${s.queued} · ${m.last}: ${s.lastTime ?? m.none}`;
  document
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => (b.disabled = s.busy));
  if (s.validation)
    $("details").textContent +=
      ` · ${m.rows}: ${s.validation.rows}. ${m.valid}`;
}
async function invoke(action: string, value?: unknown) {
  try {
    render(await window.connector.invoke(action, value));
  } catch {
    $("status").textContent = messages[lang].OPERATION_FAILED;
  }
}
$("lang").addEventListener("change", () => {
  lang = input("lang").value as typeof lang;
  translate();
});
$("kind").addEventListener("change", () => {
  $("rest").hidden = input("kind").value !== "rest";
});
$("rest").hidden = true;
$("settings").addEventListener("submit", (e) => {
  e.preventDefault();
  const c: Config = {
    backend: input("backend").value,
    kind: input("kind").value as Config["kind"],
    mapping: Object.fromEntries(
      keys.map((k) => [k, input("map-" + k).value]),
    ) as Config["mapping"],
    expectedRows: Number(input("count").value),
    knowledge: "reported_stock",
    intervalMinutes: Number(input("interval").value),
  };
  if (c.kind === "rest")
    c.rest = {
      url: input("restUrl").value,
      token: input("restToken").value,
      itemsPath: input("itemsPath").value,
      totalPath: input("totalPath").value,
      timePath: input("timePath").value,
      pageParam: input("pageParam").value,
      pageSizeParam: input("sizeParam").value,
      pageSize: Number(input("size").value),
    };
  void invoke("configure", c);
  input("restToken").value = "";
});
$("pair").addEventListener("submit", (e) => {
  e.preventDefault();
  void invoke("pair", input("code").value);
  input("code").value = "";
});
for (const id of ["choose", "sync", "pause", "clear", "inspect"])
  $(id).addEventListener("click", () => void invoke(id));
$("startup").addEventListener(
  "change",
  () => void invoke("startup", input("startup").checked),
);
window.connector.onState(render);
translate();
void invoke("state");

void window.connector
  .settings()
  .then((c) => {
    if (!c) return;
    input("backend").value = c.backend;
    input("kind").value = c.kind;
    input("count").value = String(c.expectedRows);
    input("interval").value = String(c.intervalMinutes);
    for (const key of keys) input("map-" + key).value = c.mapping[key] ?? "";
    if (c.rest) {
      for (const [id, key] of Object.entries({
        restUrl: "url",
        itemsPath: "itemsPath",
        totalPath: "totalPath",
        timePath: "timePath",
        pageParam: "pageParam",
        sizeParam: "pageSizeParam",
        size: "pageSize",
      }))
        input(id).value = String(c.rest[key as keyof typeof c.rest] ?? "");
    }
    $("rest").hidden = c.kind !== "rest";
  })
  .catch(() => {});
