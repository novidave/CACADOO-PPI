import { chromium, devices } from "playwright";
const b = await chromium.launch();
for (const dev of ["Pixel 7", "iPhone 13"]) {
  const ctx = await b.newContext({ ...devices[dev] });
  await ctx.addInitScript(() => { window.opened = []; window.open = (u) => { window.opened.push(String(u)); return null; }; window.addEventListener("click", () => (window.clicks = (window.clicks || 0) + 1), true); });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3100/sk/shops/potraviny-centrum");
  await p.waitForTimeout(1000);
  const bx = await p.locator('button[data-contact="facebook"]').boundingBox();
  const cdp = await ctx.newCDPSession(p);
  const pt = [{ x: bx.x + bx.width / 2, y: bx.y + bx.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
  await p.waitForTimeout(1500);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p.waitForTimeout(500);
  console.log(dev, "opened:", await p.evaluate(() => window.opened), "clicks:", await p.evaluate(() => window.clicks || 0));
}
await b.close();
