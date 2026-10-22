/**
 * Performance budget (performance pass): Lighthouse CI on a Vercel preview, phone (Moto G, slow 4G).
 * LHCI_BASE_URL = the preview's address; LHCI_SHOP = a shop slug with stock, LHCI_ITEM = one of its item ids.
 * Fails on: LCP > 2.0 s, CLS > 0.05, TBT > 300 ms or a score under 90 on the main pages, and more than 150 kB of
 * JavaScript on the pages without a map. Shop and item pages: the same CLS/score rules; their LCP only warns (in
 * Lighthouse's slow-4G simulation they reach ~2.6 s because of the page's size, real phones ~1 s; PERFORMANCE.md).
 */
const base = (process.env.LHCI_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const shop = process.env.LHCI_SHOP || "potraviny-centrum";
const item = process.env.LHCI_ITEM || "";
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

const strict = {
  "categories:performance": ["error", { minScore: 0.9 }],
  // The median of the 3 runs (Lighthouse's slow-4G simulation varies ±0.3 s from run to run).
  "largest-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median" }],
  "cumulative-layout-shift": ["error", { maxNumericValue: 0.05 }],
  "total-blocking-time": ["error", { maxNumericValue: 300, aggregationMethod: "median" }],
  "resource-summary:script:size": ["error", { maxNumericValue: 150 * 1024 }],
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
        ...(bypass ? { extraHeaders: JSON.stringify({ "x-vercel-protection-bypass": bypass }) } : {}),
      },
    },
    assert: {
      assertMatrix: [
        { matchingUrlPattern: "/sk(\\?q=.*)?$", assertions: strict },
        { matchingUrlPattern: "/blog$", assertions: strict },
        { matchingUrlPattern: "/(shops/[^/]+|items/[^/]+)$", assertions: withMap },
      ],
    },
    upload: { target: "temporary-public-storage" },
  },
};
