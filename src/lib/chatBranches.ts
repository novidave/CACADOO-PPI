/**
 * The shop assistant's branches (2026-11-06, at the owner's request): the conversation is a small tree kept only in
 * this tab, as the messages were before. Editing a question ("Upraviť správu") adds a sibling of that question — the
 * old question, its answer and everything after them stay untouched — and the shown path follows, at every fork, the
 * chosen sibling (the newest one until the shopper picks another with "‹ 1/2 ›"). Only the shown path is the history
 * sent to the server. No imports: `chatBranches_test.ts` (`npm run test:chat`) runs it as it is.
 */

export interface BranchNode<E> {
  id: number;
  /** The message this one follows (null = the conversation's first message). */
  parent: number | null;
  entry: E;
}

export interface Branches<E> {
  nodes: BranchNode<E>[];
  /** The chosen child at each fork: the parent's key ("root" for the first message) → the child's id. */
  chosen: Record<string, number>;
  next: number;
}

export const emptyBranches = <E>(): Branches<E> => ({ nodes: [], chosen: {}, next: 1 });

const keyOf = (parent: number | null) => (parent === null ? "root" : String(parent));

/** The messages that follow `parent`, oldest first. */
export const childrenOf = <E>(tree: Branches<E>, parent: number | null) => tree.nodes.filter((n) => n.parent === parent);

/** The shown path: from the first message, at each fork the chosen child (else the newest one). */
export function pathOf<E>(tree: Branches<E>): BranchNode<E>[] {
  const out: BranchNode<E>[] = [];
  let parent: number | null = null;
  for (let guard = 0; guard <= tree.nodes.length; guard++) {
    const kids = childrenOf(tree, parent);
    if (!kids.length) break;
    const pick: BranchNode<E> = kids.find((k) => k.id === tree.chosen[keyOf(parent)]) ?? kids[kids.length - 1];
    out.push(pick);
    parent = pick.id;
  }
  return out;
}

/**
 * Adds a message. `parent` undefined = after the shown path's last message; a number or null = after that message
 * (an edit: the edited question's own parent). The new message becomes the chosen one at its fork.
 */
export function addNode<E>(tree: Branches<E>, entry: E, parent?: number | null): { tree: Branches<E>; id: number } {
  const after = parent !== undefined ? parent : (pathOf(tree).at(-1)?.id ?? null);
  const id = tree.next;
  return {
    id,
    tree: { nodes: [...tree.nodes, { id, parent: after, entry }], chosen: { ...tree.chosen, [keyOf(after)]: id }, next: id + 1 },
  };
}

/** The versions of a message: the messages that follow the same one and pass `same` (the questions), oldest first. */
export function versionsOf<E>(tree: Branches<E>, node: BranchNode<E>, same: (e: E) => boolean): BranchNode<E>[] {
  return childrenOf(tree, node.parent).filter((n) => same(n.entry));
}

/** "‹ 1/2 ›": another version of a message is shown (its own path below it comes back as it was). */
export function choose<E>(tree: Branches<E>, node: BranchNode<E>): Branches<E> {
  return { ...tree, chosen: { ...tree.chosen, [keyOf(node.parent)]: node.id } };
}

/** How many branches the conversation has (its ends); "2 vetvy" shows only above one. */
export function branchCount<E>(tree: Branches<E>): number {
  if (!tree.nodes.length) return 0;
  const parents = new Set(tree.nodes.map((n) => n.parent));
  return tree.nodes.filter((n) => !parents.has(n.id)).length;
}

/** The history up to (and with) message `upTo` on the shown path; null = nothing before (an edit of the first one). */
export function pathUpTo<E>(tree: Branches<E>, upTo: number | null): BranchNode<E>[] {
  if (upTo === null) return [];
  const path = pathOf(tree);
  const at = path.findIndex((n) => n.id === upTo);
  return at < 0 ? path : path.slice(0, at + 1);
}

/** Which plural text a count takes in a language ("2 vetvy", "5 vetiev"): one, few or other. */
export function pluralKey(n: number, lang: string): "one" | "few" | "other" {
  let cat: string;
  try {
    cat = new Intl.PluralRules(lang).select(n);
  } catch {
    cat = n === 1 ? "one" : "other";
  }
  return cat === "one" ? "one" : cat === "few" ? "few" : "other";
}
