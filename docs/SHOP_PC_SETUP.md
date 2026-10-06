# Shop PC setup

How a shop's Windows PC sends its stock to PPI. There is nothing to install on the PC except the PPI app
itself, which is the PPI website installed from Edge or Chrome. No tunnel, no file server and no router changes
are needed.

```
shop's stock software ──export every 15–30 min──▶ export folder, e.g. C:\Export\stock.xml
                                                        │  (read only)
PPI window (Edge/Chrome, /sync page) ───────────────────┘
   every 15 minutes, while it is open:
   newest stock file, finished for at least a minute and not yet sent
        │  HTTPS upload with the owner's login
        ▼
Supabase "stock-pull" function ──▶ same checks and AI field mapping as before ──▶ stock in PPI
```

- The owner picks the folder once with **Prepojiť priečinok**. The browser remembers it.
- PPI can read only that folder and cannot change anything on the PC.
- While the page is open (minimised is fine), it checks the folder every 15 minutes. If the export is newer than
  the last file PPI applied, it sends it. A file written less than a minute ago waits for the next minute, so a
  half-written export is never sent (a cut-off list would set the missing items to 0).
- Installed as an app and placed in the Windows startup folder, PPI opens by itself when the PC starts.
- Works in **Microsoft Edge** and **Google Chrome** on a computer. Firefox and Safari cannot read a folder, so the
  page shows a message instead.

**Rehearse on your own Windows PC first (part R)**, then do the first real shop.

---

## Part S — The shop PC (about 10 minutes, once per shop)

### S1. Before you go

- The owner has an account (**Pre obchody → Vytvoriť bezplatný účet obchodu**, then the confirmation e-mail) and has
  created the shop under **Môj obchod**. Everything below is also explained on that page.
- The shop PC runs **Windows 10 or 11** with **Microsoft Edge** (already on every Windows PC) or **Google Chrome**.

### S2. The shop's stock software: scheduled export

In the stock or cash register software (or with its vendor's help):

| Setting | Value |
|---|---|
| Export folder and file | a folder only for this, e.g. `C:\Export\stock.xml` (or `stock.csv` / `stock.xlsx`), always the same name, overwritten each time |
| Format | XML, CSV (UTF-8 or Windows-1250, `;` or `,`) or Excel `.xlsx` (not the old `.xls`) |
| Columns | item code, name, quantity, selling price incl. VAT; EAN and brand if available; currency if not the shop's usual one |
| Schedule | every 15–30 minutes during opening hours, plus a full export at night |
| Content | **all** items in one file (an item missing from the file counts as quantity 0) |

Only public information: no purchase prices, suppliers or customer data.

PPI sends the **newest** XML / CSV / TXT / XLSX file in that folder, so keep other exports out of it.

### S3. Sign in and connect the folder

On the shop PC, in **Edge** or **Chrome**:

1. Open the PPI website → **Pre obchody** → log in with the owner's e-mail and password.
2. **Môj obchod** → section **Priečinok s exportom** (or **Priečinok s exportom** in the menu).
3. Click **Prepojiť priečinok**, choose the export folder from S2 → **Vybrať priečinok** (Select folder) → when
   the browser asks, **Zobraziť súbory** / **View files** (read access).
4. The page shows the folder, the newest file and the result:
   - "Súbor prijatý … skontrolujte jeho stĺpce" — the first file arrived. Continue with S5.
   - "Najnovší súbor bol zapísaný pred menej ako minútou" — the export is still being written; it is sent
     within a minute or two.

### S4. Install the app and start it with Windows

On the same page, under **Spúšťanie so systémom Windows**:

1. **Nainštalovať PPI ako aplikáciu** → **Inštalovať**. If there is no button:
   - Edge: menu **⋯** → **Aplikácie** → **Nainštalovať túto lokalitu ako aplikáciu**.
   - Chrome: menu **⋮** → **Prenášať, uložiť a zdieľať** → **Nainštalovať stránku ako aplikáciu**.

   PPI opens in its own window, on the export folder page.
2. Start PPI with Windows:
   1. **Štart** → **Všetky aplikácie** → right-click **PPI** → **Viac** → **Otvoriť umiestnenie súboru**.
   2. Select the **PPI** shortcut → **Ctrl+C**.
   3. **Windows+R** → type `shell:startup` → **Enter**.
   4. In the folder that opens → **Ctrl+V**.
3. Sleep: **Nastavenia** → **Systém** → **Napájanie** → **Režim spánku: Nikdy** (at least during opening hours).
4. Restart the PC to test. PPI opens by itself. The first time after a restart the browser may ask again for the
   folder: click **Povoliť prístup k priečinku** and choose **Povoliť pri každej návšteve** / **Allow on every
   visit**, so it does not ask again.

Leave the PPI window open; minimising it is fine. Closing it stops the uploads until it is opened again.

### S5. Approve the columns (the owner, once per shop)

**Môj obchod** → **Stĺpce súboru so zásobami**:

1. Each field (item code, name, quantity, price, …) shows the column PPI suggests, next to the file's first rows.
   Correct a drop-down if needed → **Schváliť stĺpce**.
2. The PPI window sends the file again at its next check (or click **Skontrolovať teraz**) → "Zásoby odoslané.
   Aktualizované položky: …".
3. **Zobraziť stránku obchodu** shows the items with fresh stock. From now on every new export arrives by itself.

If the export layout changes later, PPI keeps the previous stock and suggests new columns; approve them the same way.

---

## Part R — Rehearsal on your own Windows PC

1. On your PC, sign up as a shop owner (`/sk/signup`) and create a test shop under **Môj obchod**.
2. Make a folder, e.g. `C:\PPI-test`, and save the sample file there:
   `https://<your PPI address>/samples/stock-sample.csv` (right-click → Save as… → `stock.csv`).
3. **Prepojiť priečinok** → `C:\PPI-test` → wait a minute → "Súbor prijatý".
4. **Môj obchod → Stĺpce súboru so zásobami → Schváliť stĺpce** → "Zásoby odoslané" shortly after.
5. Open `stock.csv` in Notepad, change a quantity, save, wait 2 minutes, **Skontrolovať teraz** → the public page
   shows the new quantity.
6. Delete one line, save, wait 2 minutes, **Skontrolovať teraz** → that item shows as sold out.
7. Install the app (S4) and restart the PC to see it open by itself.

---

## Troubleshooting

| The PPI window says | What to do |
|---|---|
| "…funguje len v prehliadači Microsoft Edge alebo Google Chrome" | Open the page in Edge or Chrome (not Firefox, Safari or a phone). |
| "Ste odhlásený" | Sign in again on this PC (S3 step 1), then reopen PPI. |
| "Povoliť prístup k priečinku" button | Click it and choose **Allow on every visit**. |
| "V priečinku zatiaľ nie je súbor so zásobami" | Check the export folder and file type in the stock software (S2). |
| "Odoslanie zlyhalo: …" | Internet down, or PPI being updated. It tries again at the next check. |
| "PPI už sleduje tento priečinok v inom okne" | PPI is open twice. Close the extra window or tab. |
| Dashboard: "Okno PPI … naposledy aktívne" is old | The PC is off or asleep, or the PPI window was closed. |

**Moving to another PC:** do S3 and S4 on the new PC, then close PPI on the old one.
