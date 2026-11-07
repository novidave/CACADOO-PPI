// Unit tests of the shop assistant's my_project (update 95). Run: npm run test:chat
import { assertEquals } from "jsr:@std/assert@1";
import { PROJECT_TOOL, projectToolResult, projectTools, wantsProjectForm } from "./projectChat.ts";

Deno.test("my_project is offered only with an enabled project and a conversation", () => {
  assertEquals(projectTools(true, true).map((t) => t.name), ["my_project"]);
  assertEquals(projectTools(false, true), []);
  assertEquals(projectTools(true, false), [], "the unlock belongs to a conversation");
});

Deno.test("without a session the tool says verify; the AI is told never to ask for the number or the code", () => {
  let n = 0;
  const next = () => `j${++n}`;
  for (const [token, data] of [[null, { ok: true, status: "x" }], ["cps_x", { ok: false }], ["cps_x", null]] as const) {
    const r = projectToolResult(token, data, next);
    assertEquals("verify" in r, true);
  }
  assertEquals(PROJECT_TOOL.description.includes("never ask for a phone number or a code"), true);
  assertEquals(wantsProjectForm(true, true), true);
  assertEquals(wantsProjectForm(true, false), false);
  assertEquals(wantsProjectForm(false, true), false);
});

Deno.test("the AI's data: only status, time, files and excerpts — never a phone, a code, a token or an id", () => {
  let n = 0;
  const data = {
    ok: true,
    status: "Montáž v piatok",
    updated_at: "2026-11-07T10:00:00Z",
    files: 2,
    excerpts: [
      { source: "navrh.pdf", page: 1, text: "Doska dub", contact_id: "c1", phone: "+421905950001" },
      { source: "", page: 2, text: "no source" },
      { source: "x.pdf", page: "3", text: "   " },
    ],
    phone: "+421905950001",
    token: "cps_secret",
    code: "123456",
    contact_id: "c1",
  };
  const r = projectToolResult("cps_secret", data as never, () => `j${++n}`);
  const text = JSON.stringify(r);
  for (const secret of ["+421905950001", "cps_secret", "123456", "contact_id", "c1\""]) {
    assertEquals(text.includes(secret), false, `no ${secret} for the AI`);
  }
  if ("verify" in r) throw new Error("expected data");
  assertEquals(r.status, "Montáž v piatok");
  assertEquals(r.excerpts, [{ ref: "j1", source: "navrh.pdf", page: 1, text: "Doska dub" }], "empty or sourceless excerpts dropped");
  assertEquals(Object.keys(r).sort(), ["excerpts", "files", "note", "status", "updated_at"]);
});
