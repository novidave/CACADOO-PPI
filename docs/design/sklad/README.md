# Sklad v Cacaduu: designs

These are the design files for the inventory system "Sklad v Cacaduu". They come from the Claude Design canvas
"Sklad v Cacaduu" (https://claude.ai/artifact/Cw4LCsBJSdifNkx1VnQz9Y) and are here for reading only.

Each `.dc.html` file is one screen. `canvas.json` gives the board layout. The files load `./support.js`, which only
the design canvas provides, so open them on the canvas to see them working. To read the layout, text and states, open
them as text.

The POS Sync Agent is a separate integration and is not part of these screens.

| Row | Screen | File |
|---|---|---|
| Sale | Predaj (phone, scanning) | `Main.dc.html` |
| Sale | PAY by square QR payment | `PlatbaQR.dc.html` |
| Sale | Predaj on a tablet | `PredajTablet.dc.html` |
| Sale | QR terminal (spare phone on the counter; the customer's half is rotated) | `QRTerminal.dc.html` |
| Product | Product card (phone) | `Produkt.dc.html` |
| Product | Product card (computer) | `ProduktDesktop.dc.html` |
| Receipt | Príjemka (phone) | `Prijemka.dc.html` |
| Receipt | Príjemka read from an invoice by AI | `PrijemkaAI.dc.html` |
| Receipt | Príjemka (computer) | `PrijemkaDesktop.dc.html` |
| Count | Inventúra (phone, blind count) | `Inventura.dc.html` |
| Count | Inventúra differences | `InventuraRozdiely.dc.html` |
| Count | Inventúra (computer) | `InventuraDesktop.dc.html` |
| Overview | Prehľad | `Prehlad.dc.html` |
| Overview | Produkty | `Produkty.dc.html` |
| Overview | Nastavenia | `Nastavenia.dc.html` |

Style follows Môj obchod:

- Quicksand font, #111 text, #5C5C5C muted text, #E4E4E4 lines.
- Status dots: green #1E9E5A, red #D64545, and yellow #F2B705, which means stale or no information. Yellow never means
  low stock.
