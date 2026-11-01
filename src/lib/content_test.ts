// Unit tests (Deno) of "Obsah stránky" (database update 38): the slide rule the editor's live preview shares with
// shop_content() (pinned posts never repeated, fewer posts → fewer slides, hidden/expired files drop out and the rest
// keep their order, the plan's slide and PDF numbers, a downgraded shop), the counters, srcset and excerpts — and
// where Môj obchod's sections live now (old addresses forwarded). Run: npm run test:content
import { ASSISTANT_SECTIONS, assistantTabUrl, CONTENT_SECTIONS, EXPORT_SECTIONS, FOLDER_SECTIONS, forwardUrl, movedFrom, sectionId, sectionPath, sectionUrl, TRANSLATION_SECTIONS } from "./dashboardPages.ts";
import {
  arrangeSlides,
  articlePhoto,
  readingMinutes,
  slideTag,
  canAdd,
  cardExcerpt,
  cropPosition,
  ratioCss,
  ratioSize,
  ratioValue,
  shownSlots,
  slideCrop,
  sliderRatio,
  slotCounts,
  srcSet,
  type LibraryItem,
  type Slot,
} from "./pageContent.ts";

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  expected ${b}\n  got      ${a}`);
}

const PRO = { maxSlides: 10, maxPdfSlides: 10 };
const FREE = { maxSlides: 5, maxPdfSlides: 1 };
const auto = (): Slot => ({ kind: "auto_post", item_id: null, post_id: null });
const pinned = (post: string | null): Slot => ({ kind: "pinned_post", item_id: null, post_id: post });
const pdf = (item: string | null): Slot => ({ kind: "pdf", item_id: item, post_id: null });
const picture = (item: string | null): Slot => ({ kind: "picture", item_id: item, post_id: null });
const items = (...list: LibraryItem[]) => new Map(list.map((i) => [i.id, i]));
const posts = (...ids: string[]) => ids.map((id) => ({ id }));
/** "post p1", "pdf a", … in the order the slider shows them. */
const labels = (slides: ReturnType<typeof arrangeSlides<{ id: string }>>) =>
  slides.map((s) => (s.kind === "post" ? `${s.auto ? "auto" : "pinned"} ${s.post.id}` : `${s.kind} ${s.itemId}`));

const library = items(
  { id: "a", kind: "pdf", ready: true },
  { id: "b", kind: "pdf", ready: true },
  { id: "c", kind: "pdf", ready: true },
  { id: "pic", kind: "picture", ready: true },
  { id: "hidden", kind: "pdf", ready: false },
);

Deno.test("davide.sk: 5 automatic posts, 3 PDFs, 1 pinned post and 1 picture in the owner's order", () => {
  const slots = [auto(), pdf("a"), auto(), pinned("p3"), picture("pic"), auto(), pdf("b"), auto(), pdf("c"), auto()];
  const slides = arrangeSlides(slots, library, posts("p1", "p2", "p3", "p4", "p5", "p6", "p7"), PRO);
  eq(labels(slides), ["auto p1", "pdf a", "auto p2", "pinned p3", "picture pic", "auto p4", "pdf b", "auto p5", "pdf c", "auto p6"], "order");
  eq(slotCounts(slots, PRO), { counts: { auto_post: 5, pinned_post: 1, pdf: 3, picture: 1 }, total: 10, left: 0 }, "counters");
});

Deno.test("A pinned post is never repeated in an automatic slot", () => {
  const slides = arrangeSlides([auto(), auto(), pinned("p1")], library, posts("p1", "p2", "p3"), PRO);
  eq(labels(slides), ["auto p2", "auto p3", "pinned p1"], "p1 only once");
  // A pinned post that is no longer visible (deleted, unpublished) frees nothing and shows nothing.
  eq(labels(arrangeSlides([auto(), pinned("gone")], library, posts("p1"), PRO)), ["auto p1"], "gone");
});

Deno.test("Fewer posts than automatic slots: no blank slides; a new post fills the first slot (also from Facebook)", () => {
  const slots = [auto(), auto(), auto(), pdf("a")];
  eq(labels(arrangeSlides(slots, library, posts("p1"), PRO)), ["auto p1", "pdf a"], "one post");
  eq(labels(arrangeSlides(slots, library, posts("new", "p1"), PRO)), ["auto new", "auto p1", "pdf a"], "after a new post");
  eq(labels(arrangeSlides(slots, library, [], PRO)), ["pdf a"], "no posts");
});

Deno.test("Hidden, expired, deleted or empty files drop out; the rest keep their order", () => {
  const slots = [pdf("a"), pdf("hidden"), picture("deleted"), pdf(null), picture("pic"), pdf("b")];
  eq(labels(arrangeSlides(slots, library, [], PRO)), ["pdf a", "picture pic", "pdf b"], "order kept");
  // A file of the other kind in a slot is not shown either (the database refuses it too).
  eq(labels(arrangeSlides([picture("a")], library, [], PRO)), [], "kind");
});

Deno.test("Plan limits: a free shop shows 5 slides with at most 1 PDF; a downgraded shop keeps every slot", () => {
  const slots = [pdf("a"), auto(), pdf("b"), auto(), auto(), picture("pic"), auto(), pdf("c")];
  eq(labels(arrangeSlides(slots, library, posts("p1", "p2", "p3", "p4"), FREE)), ["pdf a", "auto p1", "auto p2", "auto p3", "picture pic"], "free");
  eq(shownSlots(slots, library, FREE).map((s) => s.index), [0, 1, 3, 4, 5], "indexes of the shown slots");
  // Only files that would be shown count towards the plan's PDFs: a hidden first PDF lets the next one in.
  eq(labels(arrangeSlides([pdf("hidden"), pdf("b")], library, [], FREE)), ["pdf b"], "hidden PDF not counted");
  // Automatic slots count even while they are empty (the slider's look does not jump when a post comes).
  eq(labels(arrangeSlides([auto(), auto(), auto(), auto(), auto(), picture("pic")], library, [], FREE)), [], "empty autos still count");
});

Deno.test("Counters: 'Zostáva X slotov' and what may still be added", () => {
  eq(slotCounts([auto(), pdf("a")], FREE).left, 3, "left");
  eq(canAdd([auto(), pdf("a")], "pdf", FREE), false, "second PDF on free");
  eq(canAdd([auto(), pdf("a")], "picture", FREE), true, "picture on free");
  eq(canAdd([auto(), auto(), auto(), auto(), auto()], "auto_post", FREE), false, "free full");
  eq(canAdd(Array.from({ length: 9 }, auto), "pdf", PRO), true, "pro 10th");
  eq(canAdd(Array.from({ length: 10 }, auto), "auto_post", { maxSlides: 12, maxPdfSlides: 10 }), false, "never more than 10");
});

Deno.test("srcset only when the picture is wider than 800 px (a picture is never enlarged)", () => {
  eq(srcSet({ small: "s.webp", large: "l.webp", width: 1600, height: 2000 }), "s.webp 800w, l.webp 1600w", "large");
  eq(srcSet({ small: "s.webp", large: "l.webp", width: 1200, height: 900 }), "s.webp 800w, l.webp 1200w", "1200");
  eq(srcSet({ small: "s.webp", large: "s.webp", width: 700, height: 900 }), undefined, "small");
});

Deno.test("The card's two lines: the post's text as written, cut at a word", () => {
  eq(cardExcerpt("Krátky   text\n\ns medzerami"), "Krátky text s medzerami", "spaces");
  const long = "Čerstvé pečivo každé ráno. ".repeat(12);
  const cut = cardExcerpt(long);
  eq(cut.endsWith("…") && cut.length <= 161 && long.startsWith(cut.slice(0, -1)), true, cut);
});

Deno.test("Môj obchod: each section has one page; old addresses are forwarded with their query", () => {
  eq(sectionPath("sk", "assistant"), "/sk/dashboard/assistant", "assistant");
  eq(sectionPath("sk", "imports"), "/sk/sync", "imports back with the stock file (update 43)");
  eq(sectionPath("sk", "danger"), "/sk/sync", "Nebezpečná zóna – sklad");
  eq(sectionPath("hu", "content"), "/hu/dashboard/content", "content");
  eq(sectionPath("sk", "library"), "/sk/dashboard/content", "library");
  eq(sectionPath("sk", "export"), "/sk/sync", "export stays");
  eq(sectionId("private"), "docs", "Súkromné priečinky = the documents");
  eq(sectionId("sections"), "content", "Sekcie stránky (PDF) → Obsah stránky");
  eq(sectionUrl("sk", "cloud", { shop: "davide", ok: "cloud_connected" }), "/sk/dashboard/assistant?shop=davide&ok=cloud_connected&at=cloud#cloud", "cloud");
  eq(movedFrom("sync", "imports"), false, "/sync?at=imports stays");
  eq(movedFrom("assistant", "imports"), true, "the old address on Asistent is forwarded");
  eq(forwardUrl("sk", "imports", { shop: "davide", at: "imports" }), "/sk/sync?shop=davide&at=imports#imports", "imports → /sync");
  eq(movedFrom("sync", "private"), true, "/sync?at=private");
  eq(movedFrom("sync", "export"), false, "export");
  eq(movedFrom("dashboard", "sections"), true, "/dashboard?at=sections");
  eq(movedFrom("dashboard", "cloud"), true, "/dashboard?at=cloud");
  eq(movedFrom("dashboard", "items"), true, "/dashboard?at=items → Jazyky a inventár");
  eq(movedFrom("dashboard", "columns"), true, "/dashboard?at=columns → Priečinok s exportom");
  eq(movedFrom("translations", "items"), false, "items live on translations");
  // update 62: "Preklady" became "Texty stránky" (only the page's texts; the products' translations are in Tovar)
  eq(movedFrom("translations", "texts"), false, "texts live on translations");
  eq(movedFrom("translations", "translations"), true, "the old name is forwarded");
  eq(forwardUrl("sk", "translations", { shop: "davide", at: "translations" }), "/sk/dashboard/translations?shop=davide&at=texts#texts", "translations → texts");
  eq(sectionUrl("sk", "translations", { shop: "davide" }), "/sk/dashboard/translations?shop=davide&at=texts#texts", "old links land on Texty stránky");
  eq(movedFrom("dashboard", "texts"), true, "/dashboard?at=texts → Jazyky a inventár");
  // each section lives on exactly one page
  const all = [...ASSISTANT_SECTIONS, ...FOLDER_SECTIONS, ...EXPORT_SECTIONS, ...CONTENT_SECTIONS, ...TRANSLATION_SECTIONS];
  eq(all.length, new Set(all).size, "no section on two pages");
  eq(sectionPath("sk", "columns"), "/sk/sync", "columns (update 45: Po nahratí súboru)");
  // update 45: the languages, the columns and the files in other languages moved to Priečinok s exportom
  for (const old of ["languages", "columns", "files"]) eq(movedFrom("translations", old), true, `${old} left Jazyky a inventár`);
  eq(forwardUrl("sk", "languages", { shop: "davide", at: "languages", ok: "languages" }), "/sk/sync?shop=davide&at=review&ok=languages#review", "languages → review");
  eq(forwardUrl("sk", "files", { shop: "davide", at: "files" }), "/sk/sync?shop=davide&at=trfolder#trfolder", "files → trfolder");
  eq(sectionUrl("sk", "columns", { shop: "davide", ok: "columns" }), "/sk/sync?shop=davide&ok=columns&at=review#review", "the columns form comes back to its section");
  eq([movedFrom("sync", "review"), movedFrom("sync", "trfolder")], [false, false], "they live on sync");
  eq(forwardUrl("sk", "items", { shop: "davide", at: "items", q: "káva" }), "/sk/dashboard/translations?shop=davide&at=items&q=k%C3%A1va#items", "items forwarded with the search");
  // update 63: Súkromné priečinky have their own page; the assistant's settings are the tab "Nastavenia"
  eq(movedFrom("assistant", "docs"), true, "docs moved to /dashboard/assistant/folders");
  eq(movedFrom("folders", "docs"), false, "docs live on folders");
  eq(movedFrom("assistant", "private"), true, "old name");
  eq(movedFrom("assistant", "assistant"), true, "the old settings tab");
  eq(movedFrom("assistant", "settings"), false, "settings");
  eq(forwardUrl("sk", "assistant", { shop: "davide", at: "assistant", ok: "assistant" }), "/sk/dashboard/assistant?shop=davide&at=settings&ok=assistant#settings", "assistant → settings");
  eq(forwardUrl("sk", "docs", { shop: "davide", at: "docs" }), "/sk/dashboard/assistant/folders?shop=davide&at=docs#docs", "docs → folders");
  eq(sectionUrl("sk", "docs", { shop: "davide", ok: "doc_saved" }), "/sk/dashboard/assistant/folders?shop=davide&ok=doc_saved&at=docs#docs", "the folders' forms come back");
  eq(assistantTabUrl("sk", "overview", "davide"), "/sk/dashboard/assistant?shop=davide", "Prehľad");
  eq(assistantTabUrl("sk", "conversations", "davide"), "/sk/dashboard/assistant?shop=davide&at=conversations", "Konverzácie");
  eq(assistantTabUrl("sk", "contacts", "davide"), "/sk/dashboard/contacts?shop=davide", "Kontakty");
  eq(assistantTabUrl("sk", "templates", "davide"), "/sk/dashboard/contacts?shop=davide&view=templates", "Šablóny");
  eq(assistantTabUrl("hu", "bookings", "davide"), "/hu/dashboard/bookings?shop=davide", "Rezervácie");
  eq(assistantTabUrl("sk", "settings", "davide"), "/sk/dashboard/assistant?shop=davide&at=settings", "Nastavenia");
  eq(movedFrom("content", "library"), false, "library");
  eq(forwardUrl("sk", "private", { shop: "davide", at: "private" }), "/sk/dashboard/assistant/folders?shop=davide&at=docs#docs", "private → docs");
  eq(forwardUrl("sk", "sections", { shop: "davide", at: "sections", ok: "x" }), "/sk/dashboard/content?shop=davide&at=content&ok=x#content", "sections");
});

// ---------------------------------------------------------------- videos (update 39)
import { isFacebookUrl, videoHref, videoSlide, youtubeEmbed, youtubeId, type PostVideo } from "./video.ts";

Deno.test("YouTube addresses: the video id from watch, youtu.be, shorts, live, embed; nothing from other sites", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ]) eq(youtubeId(url), "dQw4w9WgXcQ", url);
  for (const url of ["https://www.youtube.com/channel/UCx", "https://www.youtube.com/watch?v=short", "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "", null]) {
    eq(youtubeId(url), null, String(url));
  }
  eq(youtubeEmbed("dQw4w9WgXcQ").startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"), true, "the private player");
});

Deno.test("The slider's ▶: the article (at its video) or the post on Facebook, as the owner chose", () => {
  const fbVideo: PostVideo = { kind: "facebook", youtube_id: null, link: "https://www.facebook.com/111/videos/901", facebook_url: "https://www.facebook.com/111/posts/901" };
  const ytShare: PostVideo = { kind: "youtube", youtube_id: "dQw4w9WgXcQ", link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", facebook_url: "https://www.facebook.com/111/posts/902" };
  const own: PostVideo = { kind: "youtube", youtube_id: "dQw4w9WgXcQ", link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", facebook_url: null };
  const post = "/sk/shops/davide/blog/recept";
  eq(videoHref(fbVideo, "post", post), { href: `${post}#video`, external: false }, "Facebook video → the article");
  eq(videoHref(ytShare, "post", post), { href: `${post}#video`, external: false }, "YouTube → the article (plays there)");
  eq(videoHref(fbVideo, "facebook", post), { href: "https://www.facebook.com/111/posts/901", external: true }, "the Facebook post, not just the video");
  eq(videoHref(ytShare, "facebook", post), { href: "https://www.facebook.com/111/posts/902", external: true }, "a YouTube share → its Facebook post");
  eq(videoHref({ ...fbVideo, facebook_url: null }, "facebook", post), { href: "https://www.facebook.com/111/videos/901", external: true }, "no post address: the Facebook video");
  eq(videoHref(own, "facebook", post), { href: `${post}#video`, external: false }, "not on Facebook → always the article");
  eq(videoHref({ ...ytShare, facebook_url: "https://evil.example/x" }, "facebook", post).external, false, "only Facebook addresses");
  eq(videoSlide(null, "facebook", post), null, "not a video post");
  eq(videoSlide(ytShare, "facebook", post)?.facebook, true, "the Facebook label");
  eq(isFacebookUrl("https://fb.watch/abc") && isFacebookUrl("https://m.facebook.com/x") && !isFacebookUrl("http://www.facebook.com/x"), true, "https Facebook only");
});

Deno.test("update 44: one frame for every slide (Pomer strán slidera) and the Výrez", () => {
  eq(sliderRatio(null), "4:5", "never chosen = 4:5");
  eq(sliderRatio("1:1"), "1:1", "1:1 kept");
  eq(sliderRatio("3:2"), "4:5", "an unknown ratio = 4:5");
  eq([ratioValue("4:5"), ratioValue("1:1"), ratioValue("16:9").toFixed(4)], [0.8, 1, "1.7778"], "width ÷ height");
  eq(ratioCss("16:9"), "16 / 9", "CSS aspect-ratio");
  eq([ratioSize("4:5"), ratioSize("1:1"), ratioSize("16:9")], ["1080 × 1350", "1080 × 1080", "1600 × 900"], "the upload hint's size");
  eq(1080 / 1350, ratioValue("4:5"), "the hinted size has the frame's ratio");
  eq([slideCrop(undefined), slideCrop("top"), slideCrop("left")], ["center", "top", "center"], "Výrez: the middle unless chosen");
  eq([cropPosition("top"), cropPosition("center"), cropPosition("bottom")], ["50% 0%", "50% 50%", "50% 100%"], "object-position");
});

// ---------------------------------------------------------------- Screen 11: the news slider's inline article

Deno.test("reading time: 200 words a minute, rounded up, at least 1", () => {
  eq(readingMinutes(""), 1, "screen 11");
  eq(readingMinutes("Krátka správa."), 1, "screen 11");
  eq(readingMinutes(Array(200).fill("slovo").join(" ")), 1, "screen 11");
  eq(readingMinutes(Array(201).fill("slovo").join("\n")), 2, "screen 11");
  eq(readingMinutes(Array(650).fill("szó").join("  ")), 4, "screen 11");
});

Deno.test("article photo: the second photo, else the first; photos before videos' pictures", () => {
  const p = (id: string, kind: "photo" | "video" = "photo") => ({ id, kind });
  eq(articlePhoto([]), null, "screen 11");
  eq(articlePhoto([p("a")])?.id, "a", "screen 11");
  eq(articlePhoto([p("a"), p("b"), p("c")])?.id, "b", "screen 11");
  eq(articlePhoto([p("v", "video"), p("a")])?.id, "a", "screen 11");
  eq(articlePhoto([p("v", "video"), p("w", "video")])?.id, "w", "screen 11");
});

Deno.test("slide tag: a post is news, a PDF or a picture an offer", () => {
  eq(slideTag("post"), "tag_post", "screen 11");
  eq(slideTag("pdf"), "tag_offer", "screen 11");
  eq(slideTag("picture"), "tag_offer", "screen 11");
});
