import { expect, loginOwner, sk, test } from "./helpers";
import type { Page } from "@playwright/test";

/**
 * CRM → Konverzácie, the two-pane inbox (2026-11-07, database update 90; artboards 8 / 8b) at 1180×820, 820×1180 and
 * 390×844: the tab order (Konverzácie first, Prehľad last) and the tab row in the same box as on Kontakty; ≥ 1024 px the
 * list (320 px) and the conversation side by side, each scrolling inside, the open row #EDFFE1; `?c=` opens one; below
 * 1024 px one pane at a time with "‹ Konverzácie" back to the same list; "Čaká" filters; the reply row (the template
 * fills the text, the grammar button has a name and no visible text, e-mail's 260 px field vs SMS's, the text kept
 * between them); a draft stays across conversations and the row says "Koncept"; once, on the computer while SMS run in
 * test mode, a sent SMS shows as "Vy · SMS" and clears the draft; "⋯" → Archivovať (and back); the old
 * /dashboard/conversations/<id> forwards; no sideways scroll. Needs an owner login and E2E_OWNER_SHOP; every step that
 * needs data (a conversation, a contact with a channel, a template) is skipped with a note when the shop has none.
 */
const SIZES = [
  { name: "computer", width: 1180, height: 820 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

const SHOP = process.env.E2E_OWNER_SHOP ?? "";
const q = SHOP ? `?shop=${encodeURIComponent(SHOP)}` : "";
const x = sk.crm_inbox;

async function tabBox(page: Page) {
  return page.locator('[data-item-tabs="crm"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, height: r.height };
  });
}

async function noSideways(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide, "no sideways scroll").toBeLessThanOrEqual(1);
}

const note = (text: string) => test.info().annotations.push({ type: "skipped", description: text });

/** The first conversation (of the first `max` rows) whose pane has the reply form; null when none has. */
async function openReplyable(page: Page, max = 8): Promise<string | null> {
  const ids = await page.locator("[data-inbox-link]").evaluateAll((els) => els.map((e) => e.getAttribute("data-inbox-link") ?? ""));
  for (const id of ids.slice(0, max)) {
    await page.goto(`/sk/dashboard/crm${q}&c=${id}`);
    if ((await page.locator("form#reply").count()) > 0) return id;
  }
  return null;
}

for (const size of SIZES) {
  const wide = size.width >= 1024;
  test.describe(`CRM → Konverzácie ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.beforeEach(async ({ page }) => {
      test.skip(!SHOP, "needs E2E_OWNER_SHOP");
      test.skip(!(await loginOwner(page)), "no owner login configured (E2E_OWNER_EMAIL/PASSWORD or E2E_OWNER_LOGIN_URL)");
    });

    test("tabs, panes, the open row, ?c= and back, Čaká, old addresses", async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(`/sk/dashboard/contacts${q}`);
      const contactsTabs = await tabBox(page);
      await page.goto(`/sk/dashboard/crm${q}`);
      // Konverzácie · Kontakty · Šablóny · Správy · Prehľad; Konverzácie open; the tab row where it is on Kontakty
      const keys = await page.locator('[data-item-tabs="crm"] [data-tab]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab")));
      expect(keys).toEqual(["conversations", "contacts", "templates", "messages", "overview"]);
      await expect(page.locator('[data-tab="conversations"]')).toHaveAttribute("aria-current", "page");
      const tabs = await tabBox(page);
      expect(Math.abs(tabs.x - contactsTabs.x) + Math.abs(tabs.y - contactsTabs.y) + Math.abs(tabs.height - contactsTabs.height)).toBeLessThanOrEqual(1.5);
      await noSideways(page);

      // old addresses
      await page.goto(`/sk/dashboard/crm${q}&at=conversations`);
      await expect(page).not.toHaveURL(/at=conversations/);
      await page.goto(`/sk/dashboard/crm${q}&at=cloud`);
      await expect(page).toHaveURL(/at=overview/);
      await expect(page.locator('[data-tab="overview"]')).toHaveAttribute("aria-current", "page");

      await page.goto(`/sk/dashboard/crm${q}`);
      const rows = page.locator("[data-inbox-row]");
      if ((await rows.count()) === 0) {
        await expect(page.locator("[data-inbox-empty], [data-inbox-none], [data-pro-only]").first()).toBeVisible();
        note("the test shop has no conversation");
        return;
      }
      const list = page.locator("[data-inbox-list]");
      const pane = page.locator("[data-inbox-pane]");
      if (wide) {
        // two panes side by side; the list 320 px; each scrolls inside; the inbox ends inside the window
        await expect(list).toBeVisible();
        await expect(pane).toBeVisible();
        const l = (await list.boundingBox())!;
        const p = (await pane.boundingBox())!;
        expect(l.width).toBeCloseTo(320, 0);
        expect(p.x).toBeGreaterThanOrEqual(l.x + l.width - 1);
        const frame = (await page.locator("[data-inbox]").boundingBox())!;
        expect(frame.y + frame.height, "the inbox fits the window").toBeLessThanOrEqual(size.height + 1);
        expect(await page.locator("[data-inbox-rows]").evaluate((e) => getComputedStyle(e).overflowY)).toBe("auto");
        expect(await page.locator("[data-inbox-messages]").evaluate((e) => getComputedStyle(e).overflowY)).toBe("auto");
        // a computer opens one by itself: its row is the open one
        const open = page.locator('[data-inbox-link][aria-current="true"]');
        await expect(open).toHaveCount(1);
        const bg = await open.evaluate((a) => getComputedStyle(a.parentElement!).backgroundColor);
        expect(bg).toBe("rgb(237, 255, 225)");
      } else {
        // one pane at a time: without ?c= the list
        await expect(list).toBeVisible();
        await expect(pane).toBeHidden();
      }

      // ?c= opens a row; on a phone or a tablet "‹ Konverzácie" goes back to the same list
      const target = await page.locator("[data-inbox-link]").nth((await rows.count()) > 1 ? 1 : 0).getAttribute("data-inbox-link");
      await page.locator(`[data-inbox-link="${target}"]`).click();
      await expect(page).toHaveURL(new RegExp(`c=${target}`));
      await expect(page.locator(`[data-inbox-pane="${target}"]`)).toBeVisible();
      await expect(page.locator(`[data-inbox-link="${target}"]`)).toHaveAttribute("aria-current", "true");
      if (!wide) {
        await expect(list).toBeHidden();
        const back = page.locator("[data-inbox-back]");
        await expect(back).toHaveText(x.back);
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(47.5);
        await back.click();
        await expect(page).not.toHaveURL(/[?&]c=/);
        await expect(list).toBeVisible();
      }
      await noSideways(page);

      // the old address of one conversation forwards to ?c=
      await page.goto(`/sk/dashboard/conversations/${target}`);
      await expect(page).toHaveURL(new RegExp(`/dashboard/crm\\?.*c=${target}`));

      // Čaká: only waiting rows
      await page.goto(`/sk/dashboard/crm${q}`);
      await page.locator('[data-inbox-filter="waiting"]').click();
      await expect(page).toHaveURL(/f=waiting/);
      await expect(page.locator('[data-inbox-filter="waiting"]')).toHaveAttribute("aria-current", "page");
      const waiting = page.locator("[data-inbox-row]");
      for (let i = 0; i < Math.min(await waiting.count(), 5); i++) {
        await expect(waiting.nth(i).locator('[data-row-tag="waiting"]')).toHaveCount(1);
      }
    });

    test("the reply: template, grammar icon, SMS / e-mail, a draft across conversations, (a test-mode SMS)", async ({ page }) => {
      test.setTimeout(150_000);
      await page.goto(`/sk/dashboard/crm${q}`);
      const id = await openReplyable(page);
      if (!id) {
        note("no conversation with a contact that has a phone or an e-mail (or no Pro)");
        return;
      }
      const form = page.locator("form#reply");
      const body = form.locator("[data-compose-body]");

      // the grammar button: an icon with a name, no visible text
      const grammar = form.locator("[data-grammar-run]");
      if (await grammar.count()) {
        await expect(grammar).toHaveAttribute("aria-label", sk.contacts.grammar);
        expect((await grammar.innerText()).trim()).toBe("");
      }

      // a template fills the text and the picker goes back to "Vybrať šablónu"
      const pick = form.locator("[data-template-pick]");
      if ((await pick.count()) && (await pick.locator("option").count()) > 1) {
        await body.fill("");
        const value = await pick.locator("option").nth(1).getAttribute("value");
        await pick.selectOption(value!);
        await expect(body).not.toHaveValue("");
        await expect(pick).toHaveValue("");
      }

      // SMS vs e-mail: the e-mail field is 260 px, the text stays when switching
      const stamp = `E2E koncept ${size.name} ${Date.now().toString().slice(-6)}`;
      await body.fill(stamp);
      if ((await form.locator('[data-reply-channel="sms"]').count()) && (await form.locator('[data-reply-channel="email"]').count())) {
        await form.locator('[data-reply-channel="sms"]').click();
        const smsHeight = (await form.locator("[data-compose-body]").boundingBox())!.height;
        await form.locator('[data-reply-channel="email"]').click();
        await expect(page.locator('form#reply[data-reply="email"]')).toBeVisible();
        const emailBody = page.locator("form#reply [data-compose-body]");
        await expect(emailBody).toHaveValue(stamp);
        expect((await emailBody.boundingBox())!.height).toBeCloseTo(260, 0);
        expect(smsHeight).toBeLessThan(200);
        await page.locator('form#reply [data-reply-channel="sms"]').click();
        await expect(page.locator("form#reply [data-compose-body]")).toHaveValue(stamp);
      }

      // the draft is saved, stays when another conversation is opened and the row says "Koncept"
      await expect(page.locator("[data-draft-status]")).toHaveAttribute("data-draft-status", "saved", { timeout: 10_000 });
      const other = await page.locator(`[data-inbox-link]:not([data-inbox-link="${id}"])`).first().getAttribute("data-inbox-link");
      if (other) await page.goto(`/sk/dashboard/crm${q}&c=${other}`);
      await page.goto(`/sk/dashboard/crm${q}&c=${id}`);
      await expect(page.locator("form#reply [data-compose-body]")).toHaveValue(stamp);
      await expect(page.locator(`[data-inbox-row="${id}"] [data-row-tag="draft"]`)).toHaveCount(1);
      await expect(page.locator(`[data-inbox-row="${id}"]`)).toContainText(x.draft_prefix);

      // once, on the computer, while SMS are only written down: "Odoslať SMS" → "Vy · SMS", the draft cleared
      const testMode = (await page.getByText(sk.contacts.sms_test_note).count()) > 0;
      if (size.name === "computer" && testMode && (await page.locator('form#reply[data-reply="sms"]').count())) {
        await page.locator("form#reply [data-reply-send]").click();
        await expect(page.locator("[data-compose-result]")).toHaveAttribute("data-compose-result", /sent/, { timeout: 20_000 });
        await page.goto(`/sk/dashboard/crm${q}&c=${id}`);
        await expect(page.locator('[data-role="owner"]').last()).toContainText(stamp);
        await expect(page.locator('[data-role="owner"]').last()).toContainText("Vy · SMS");
        await expect(page.locator(`[data-inbox-row="${id}"] [data-row-tag="draft"]`)).toHaveCount(0);
        await expect(page.locator("form#reply [data-compose-body]")).toHaveValue("");
      } else {
        // leave nothing behind: an empty text clears the draft
        await page.locator("form#reply [data-compose-body]").fill("");
        await page.locator("form#reply [data-compose-body]").blur();
        await expect(page.locator("[data-draft-status]")).not.toHaveAttribute("data-draft-status", "saving", { timeout: 10_000 });
        await page.goto(`/sk/dashboard/crm${q}&c=${id}`);
        await expect(page.locator(`[data-inbox-row="${id}"] [data-row-tag="draft"]`)).toHaveCount(0);
      }
      await noSideways(page);
    });

    if (size.name === "computer") {
      test("⋯ → Archivovať and back", async ({ page }) => {
        await page.goto(`/sk/dashboard/crm${q}`);
        const first = page.locator("[data-inbox-link]").first();
        if ((await first.count()) === 0) {
          note("the test shop has no conversation");
          return;
        }
        const id = await first.getAttribute("data-inbox-link");
        await page.goto(`/sk/dashboard/crm${q}&c=${id}`);
        const menu = page.locator("[data-inbox-menu]");
        await menu.locator("summary").click();
        const archive = menu.locator('[data-mark="archive"]');
        if ((await archive.count()) === 0) {
          note("already archived");
          return;
        }
        await archive.click();
        await expect(page).toHaveURL(new RegExp(`c=${id}`));
        await page.locator("[data-inbox-menu] summary").click();
        await expect(page.locator('[data-inbox-menu] [data-mark="unarchive"]')).toBeVisible();
        await page.locator('[data-inbox-menu] [data-mark="unarchive"]').click();
        await page.locator("[data-inbox-menu] summary").click();
        await expect(page.locator('[data-inbox-menu] [data-mark="archive"]')).toBeVisible();
      });
    }
  });
}
