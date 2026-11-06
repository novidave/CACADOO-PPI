// `npm run test:chat` — the shop assistant's branches (2026-11-06): an edited question makes a sibling, the old branch
// stays as it was, "‹ 1/2 ›" switches the whole path below, only the shown path is the history, the plural pill.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addNode, branchCount, choose, emptyBranches, pathOf, pathUpTo, pluralKey, versionsOf } from "./chatBranches.ts";

type E = { role: "user" | "assistant"; text: string };
const q = (text: string): E => ({ role: "user", text });
const a = (text: string): E => ({ role: "assistant", text });
const isQ = (e: E) => e.role === "user";
const texts = (t: ReturnType<typeof emptyBranches<E>>) => pathOf(t).map((n) => n.entry.text);

Deno.test("branches: an edit is a sibling; the old branch and what follows it stay; the pager switches the path", () => {
  let t = emptyBranches<E>();
  let r = addNode(t, q("Máte pizzu?"));
  t = r.tree;
  const q1 = r.id;
  t = addNode(t, a("Áno, Margherita."), q1).tree;
  r = addNode(t, q("Koľko stojí?"));
  t = r.tree;
  const q2 = r.id;
  t = addNode(t, a("8,90 €"), q2).tree;
  assertEquals(texts(t), ["Máte pizzu?", "Áno, Margherita.", "Koľko stojí?", "8,90 €"]);
  assertEquals(branchCount(t), 1, "one branch: no pill");

  // edit the first question: a sibling at the root, shown with its own new answer
  const first = t.nodes.find((n) => n.id === q1)!;
  r = addNode(t, q("Máte cestoviny?"), first.parent);
  t = r.tree;
  t = addNode(t, a("Áno, carbonara."), r.id).tree;
  assertEquals(texts(t), ["Máte cestoviny?", "Áno, carbonara."]);
  assertEquals(branchCount(t), 2);
  const versions = versionsOf(t, first, isQ);
  assertEquals(versions.map((n) => n.entry.text), ["Máte pizzu?", "Máte cestoviny?"], "1/2, 2/2 in the order written");

  // back to version 1: its whole path comes back untouched
  t = choose(t, versions[0]);
  assertEquals(texts(t), ["Máte pizzu?", "Áno, Margherita.", "Koľko stojí?", "8,90 €"]);
  // a new message on branch 1 goes after its last answer, branch 2 stays as it was
  t = addNode(t, q("A s donáškou?")).tree;
  assertEquals(texts(t).at(-1), "A s donáškou?");
  t = choose(t, versions[1]);
  assertEquals(texts(t), ["Máte cestoviny?", "Áno, carbonara."]);
});

Deno.test("branches: the history of an edit is the path before the edited question only", () => {
  let t = emptyBranches<E>();
  let r = addNode(t, q("A"));
  t = addNode(r.tree, a("a"), r.id).tree;
  r = addNode(t, q("B"));
  t = addNode(r.tree, a("b"), r.id).tree;
  const b = t.nodes.find((n) => n.entry.text === "B")!;
  assertEquals(pathUpTo(t, b.parent).map((n) => n.entry.text), ["A", "a"]);
  assertEquals(pathUpTo(t, null), [], "an edit of the first question has no history");
});

Deno.test("branches: the header pill's plural (sk 2–4 vetvy, 5+ vetiev; hu / en)", () => {
  assertEquals(pluralKey(1, "sk"), "one");
  assertEquals(pluralKey(2, "sk"), "few");
  assertEquals(pluralKey(4, "sk"), "few");
  assertEquals(pluralKey(5, "sk"), "other");
  assertEquals(pluralKey(2, "hu"), "other");
  assertEquals(pluralKey(2, "en"), "other");
  assert(["one", "few", "other"].includes(pluralKey(3, "xx-invalid-?")));
});
