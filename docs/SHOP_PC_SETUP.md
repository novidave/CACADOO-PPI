# Shop PC setup (phase 7)

How a shop's Windows PC sends its stock to PPI. Nothing is uploaded from the shop: the PC offers one
read-only file through a Cloudflare tunnel, and PPI's `stock-pull` function fetches it every 15 minutes.

```
shop software ──export──▶ C:\PPI\export\stock.xml
                          │  (PPI agent copies it once the export is finished)
                          ▼
                          C:\PPI\serve\stock.xml ◀── rclone serve http, 127.0.0.1:8081, read-only, password
                                                      ▲
                                    cloudflared (Windows service, outbound only)
                                                      ▲
                     Cloudflare Access: only PPI's service token gets through
                                                      ▲
                     https://<shop>.<your domain>/stock.xml ◀── PPI stock-pull (every 15 min)
```

The shop opens no router ports. A changing or shared internet address does not matter.

**Do it first on your own Windows PC (a rehearsal, part R)**, then at the first real shop.

Secrets (tunnel token, service token secret, rclone password) never go into e-mail or chat. Type them
straight into PPI admin or keep them in your password manager.

---

## Part C — Cloudflare (once, then once per shop)

### C1. A domain on Cloudflare (once)

Each shop gets an address like `shop-name.your-domain`, so you need one domain whose DNS is on Cloudflare
(a free plan is enough). It does not have to be the website's domain.

- You already have a domain: Cloudflare dashboard → **Add a domain** → follow the steps (Free plan), then
  change the domain's nameservers at your registrar to the two Cloudflare shows. Wait until Cloudflare says
  the domain is **Active** (minutes to a few hours).
- No domain yet: Cloudflare dashboard → **Domain Registration** → **Register Domains** → buy one there; it is
  on Cloudflare at once.

Below, `example.com` stands for your domain and `shop-name` for the shop's slug in PPI.

### C2. A tunnel for the shop

Cloudflare dashboard → **Zero Trust** (the first time it asks for a team name and the Free plan; no card
needed for Free in most countries).

1. **Networks** → **Tunnels** (in newer menus: **Networks** → **Connectors** → **Cloudflare Tunnels**) →
   **Create a tunnel** → **Cloudflared** → name `ppi-shop-name` → **Save tunnel**.
2. On "Install and run a connector" choose **Windows**. The page shows a command ending in a long text that
   starts with `eyJ…`. That is the **tunnel token**. Do **not** run the command; the PPI installer does it.
   Copy the whole command into your password manager for now (or straight into the installer in part S).
   → **Next**.
3. **Public hostname** (in newer menus: **Published application routes**) → add:
   - Subdomain: `shop-name` · Domain: `example.com` · Path: *(empty)*
   - Service: Type **HTTP** · URL **`localhost:8081`**
   → **Save**.

### C3. Only PPI may read the file (Cloudflare Access)

1. **Access** → **Service credentials** (older menus: **Access** → **Service auth**) → **Service Tokens** →
   **Create Service Token** → name `ppi-shop-name`, duration **Non-expiring** → **Generate token**.
   Cloudflare shows the **Client ID** and **Client Secret** once. Put both into PPI admin (part S5) or your
   password manager now.
2. **Access** → **Applications** → **Add an application** → **Self-hosted** →
   - Application name `PPI shop-name` · Session duration: default
   - Public hostname / domain: `shop-name` . `example.com` (path empty)
   - Policy: name `PPI stock pull`, **Action: Service Auth**, Include → **Service Token** → `ppi-shop-name`
   - Login methods / identity providers: leave as is (nobody logs in; only the token is accepted).
   → **Save**.

Check: open `https://shop-name.example.com/` in your browser. You must see a Cloudflare page (login or
"Forbidden"), **never** a file list or a password prompt from the PC.

---

## Part S — The shop PC

Windows 10 or 11, the PC that runs the shop's stock software. It must be on and connected during opening
hours: **Settings → System → Power** → *When plugged in, put the device to sleep after*: **Never**.

### S1. Run the installer (as administrator)

On the shop PC: **Start** → type `PowerShell` → right-click **Windows PowerShell** → **Run as administrator**
→ **Yes**. Paste this one line and press Enter:

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm https://cacadooppivercel.vercel.app/shop-pc/install-ppi.ps1 -OutFile $env:TEMP\install-ppi.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\install-ppi.ps1 -Hostname shop-name.example.com
```

(Replace `shop-name.example.com` with the shop's address from C2. If the site moved to your own domain,
use that instead of `cacadooppivercel.vercel.app`.)

It asks for the **tunnel token**: paste the whole command or the `eyJ…` text from C2 and press Enter.

The installer:

- creates `C:\PPI\export` (the shop software writes here), `C:\PPI\serve`, `C:\PPI\bin`, `C:\PPI\logs`;
- downloads **rclone** (checksum checked) and **cloudflared** (signature checked);
- makes an rclone username and a random password;
- adds the Windows task **PPI file server** (runs at startup as SYSTEM, invisible) that
  - copies a finished export from `C:\PPI\export` to `C:\PPI\serve` — only when the file has not changed
    for a minute and the shop software has closed it, so PPI never reads a half-written list (a cut-off list
    would set the missing items to 0);
  - keeps `rclone serve http` running on `127.0.0.1:8081`: read-only, only on this PC, only with the password;
- installs the **cloudflared** Windows service with the tunnel token;
- checks that the file server needs the password and that `https://shop-name.example.com/` is blocked
  for anyone without the service token.

At the end it shows the **rclone username and password**. Type them into PPI admin (S5) or your password
manager. Show them again later with:

```powershell
powershell -ExecutionPolicy Bypass -File C:\PPI\bin\install-ppi.ps1 -ShowLogin
```

The installer keeps a copy of itself in `C:\PPI\bin\install-ppi.ps1` (use that path for the options below).
Running it again is safe: it keeps the login and the tunnel. Options: `-NewPassword` (new rclone
password; enter it in PPI admin afterwards), `-Update` (newer rclone/cloudflared), `-TunnelToken <token>`
(new tunnel), `-Uninstall` (removes everything except `C:\PPI\export`).

### S2. The shop's stock software: scheduled export

In the stock / cash register software (or with its vendor's help):

| Setting | Value |
|---|---|
| Export folder and file | `C:\PPI\export\stock.xml` (or `stock.csv` / `stock.xlsx`) — always the same name, overwritten each time |
| Format | XML, CSV (UTF-8 or Windows-1250, `;` or `,`) or Excel `.xlsx` |
| Columns | item code, name, quantity, selling price incl. VAT; EAN and brand if available; currency if not the shop's usual one |
| Schedule | every 15–30 minutes during opening hours, plus a full export at night |
| Content | **all** items in one file (an item missing from the file counts as quantity 0) |

Only public information: no purchase prices, suppliers or customer data.

If the software cannot export on a schedule by itself, ask its vendor for a command-line export and run it
from Windows **Task Scheduler** every 15 minutes.

### S3. Check on the PC

- `C:\PPI\export\stock.xml` appears and its time changes after each export.
- About a minute later the same file appears in `C:\PPI\serve`.
- `C:\PPI\logs\agent.log` shows `published stock.xml (… bytes …)`.
- **Services** (Win+R → `services.msc`): **Cloudflared agent** is *Running*.
- Cloudflare → Zero Trust → Tunnels: `ppi-shop-name` is **Healthy**.

### S4. The shop in PPI

PPI → **Správa** → the shop (or **+ Nový obchod**) → fill in the details → **Uložiť**.

### S5. Stock source in PPI admin

In the shop's admin page:

1. **Zdroj zásob** → file address `https://shop-name.example.com/stock.xml` (the exact file name from S2),
   format → **Uložiť upravené priradenie**.
2. **Prístup k súboru** → Cloudflare Access Client ID and Client Secret (C3), rclone user and password (S1)
   → save. They are stored encrypted in Supabase Vault and never shown again.
3. **Stiahnuť súbor teraz** → a field mapping is proposed → compare it with the sample rows → **Schváliť
   priradenie** → **Stiahnuť súbor teraz** again → "zásoby aktualizované".
4. Open the shop's public page: items with fresh stock. From now on the 15-minute schedule keeps it current.

---

## Part R — Rehearsal on your own Windows PC

Same as above with a test shop, before touching a shop's PC:

1. C2–C3 with the name `ppi-test` and address `test.example.com`.
2. S1 with `-Hostname test.example.com -SampleFile` added to the installer line. `-SampleFile` puts a small
   test list into `C:\PPI\export\stock.csv`.
3. S4–S5 with a test shop, file address `https://test.example.com/stock.csv`, format CSV.
4. Edit `C:\PPI\export\stock.csv` in Notepad (change a quantity), save, wait 2 minutes, **Stiahnuť súbor
   teraz** → the new quantity shows on the public page.
5. Delete a line, save, pull again → that item shows as sold out (a missing item counts as 0).
6. Done: `-Uninstall`, delete the test tunnel, service token, Access application and test shop.

---

## Troubleshooting

| PPI admin says | Look at |
|---|---|
| HTTP 403 / 401 | Prístup k súboru: Client ID/Secret from C3 and the rclone login (`-ShowLogin`); the Access policy must be **Service Auth** with this shop's token. |
| HTTP 404 | File name in the address vs. the file in `C:\PPI\serve`; is the export running (S3)? |
| HTTP 502 / 530 | The PC is off or offline, the **Cloudflared agent** service is stopped, or the tunnel's public hostname does not point to `http://localhost:8081`. |
| "unchanged" for a long time | The export stopped: check the time of `C:\PPI\export\stock.xml` and `C:\PPI\logs\agent.log` ("waiting for …" means the shop software keeps the file open). |

Logs on the PC: `C:\PPI\logs\agent.log` (publishing), `C:\PPI\logs\rclone.log` (file server).
Re-running the installer repairs a broken setup without changing the login or the tunnel.

**Moving to another PC:** run the installer on the new PC with the same tunnel token (`-TunnelToken`) and then
`-NewPassword`, enter the new rclone password in PPI admin, and run `-Uninstall` on the old PC.
