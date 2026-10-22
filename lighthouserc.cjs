/**
 * Performance budget (performance pass): Lighthouse CI on a Vercel preview, phone (Moto G, slow 4G).
 * LHCI_BASE_URL = the preview's address; LHCI_SHOP = a shop slug with stock, LHCI_ITEM = one of its item ids.
 * Fails on: LCP > 2.0 s, CLS > 0.05, TBT > 300 ms or a score under 90 on the main page and the blog, CLS/TBT on every
 * page, and more than 170 KiB of JavaScript in all on the pages without a map. The exact first-load budget (the first
 * HTML's scripts < 150 kB gzip) is `scripts/first-load-js.mjs`; Lighthouse's total also counts Vercel Speed
 * Insights/Analytics (~11 KiB, loaded after the page) and the response headers. Only warn: LCP of shop and item pages
 * (~1.8 s, close to the line and it moves with each shop's own pictures and number of items) and LCP + score of the
 * search page (with JavaScript its largest element is the AI answer, which streams for several seconds by design: it
 * measures the AI, not the page). PERFORMANCE.md.
 *
 * Throttling is applied while the page loads ("devtools": slow 4G latency and bandwidth, 4× slower CPU), not
 * simulated afterwards: the simulation adds the download of every async script that started before the first paint
 * to the LCP even when the largest element does not wait for them (observed LCP 0.14 s, simulated 2.0–2.5 s on the
 * main page), and it hid the map's real main-thread work (now started only after the visitor's first interaction).
 */
const base = (process.env.LHCI_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const shop = process.env.LHCI_SHOP || "potraviny-centrum";
const item = process.env.LHCI_ITEM || "";
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
// No Vercel toolbar (previews only: it is not part of the site, and its cross-site requests would be measured too).
const headers = { "x-vercel-skip-toolbar": "1", ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}) };

const strict = {
  "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median" }],
  // The median of the 3 runs (Lighthouse's slow-4G simulation varies ±0.3 s from run to run).
  "largest-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median" }],
  "cumulative-layout-shift": ["error", { maxNumericValue: 0.05, aggregationMethod: "median" }],
  "total-blocking-time": ["error", { maxNumericValue: 300, aggregationMethod: "median" }],
  "resource-summary:script:size": ["error", { maxNumericValue: 170 * 1024, aggregationMethod: "median" }],
};
const search = {
  ...strict,
  "categories:performance": ["warn", { minScore: 0.9, aggregationMethod: "median" }],
  "largest-contentful-paint": ["warn", { maxNumericValue: 2000, aggregationMethod: "median" }],
};
const withMap = {
  ...strict,
  "largest-contentful-paint": ["warn", { maxNumericValue: 2000, aggregationMethod: "median" }],
  // The map's code (MapLibre) loads after the page; it is not part of the first JavaScript.
  "resource-summary:script:size": "off",
};

module.exports = {
  ci: {
    collect: {
      url: [`${base}/sk`, `${base}/sk?q=k%C3%A1va`, `${base}/sk/shops/${shop}/blog`, `${base}/sk/shops/${shop}`, ...(item ? [`${base}/sk/items/${item}`] : [])],
      numberOfRuns: 3,
      settings: {
        onlyCategories: ["performance"],
        throttlingMethod: "devtools",
        extraHeaders: JSON.stringify(headers),
      },
    },
    assert: {
      assertMatrix: [
        { matchingUrlPattern: "/sk$", assertions: strict },
        { matchingUrlPattern: "/sk\\?q=", assertions: search },
        { matchingUrlPattern: "/blog$", assertions: strict },
        { matchingUrlPattern: "/(shops/[^/]+|items/[^/]+)$", assertions: withMap },
      ],
    },
    upload: { target: "temporary-public-storage" },
  },
};
