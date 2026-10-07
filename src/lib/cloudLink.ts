/**
 * Turns a cloud "share" link into a direct download link PPI can fetch:
 *  - Google Drive file   …/file/d/<id>/view   → drive.google.com/uc?export=download&id=<id>
 *  - Google Sheets       …/spreadsheets/d/<id> → …/export?format=csv (keeps the sheet tab, gid)
 *  - Dropbox             ?dl=0                 → ?dl=1
 *  - OneDrive (personal)                       → kept; stock-pull uses OneDrive's share API
 *  - SharePoint / OneDrive for work            → adds download=1
 * Shared FOLDER links (OneDrive, Dropbox, Google Drive) are kept: stock-pull takes the
 * newest stock file in the folder. Any other https link is used as it is.
 */
export type CloudLink = { url: string } | { error: "invalid" };

export function toDownloadLink(input: string): CloudLink {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { error: "invalid" };
  }
  if (url.protocol !== "https:") return { error: "invalid" };
  const host = url.hostname.toLowerCase();

  if (host === "drive.google.com") {
    // A shared folder: stock-pull takes its newest stock file.
    if (url.pathname.includes("/folders/")) return { url: url.toString() };
    const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get("id");
    if (id) return { url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}` };
  }
  if (host === "docs.google.com") {
    const sheet = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
    if (sheet) {
      const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d+)/)?.[1];
      return {
        url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet)}/export?format=csv${gid ? `&gid=${gid}` : ""}`,
      };
    }
  }
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) {
    if (url.pathname.startsWith("/home")) return { error: "invalid" }; // own Dropbox page, not a share link
    if (/\/(scl\/fo|sh)\//.test(url.pathname)) {
      url.searchParams.delete("dl"); // a shared folder: stock-pull downloads it as ZIP
      return { url: url.toString() };
    }
    url.searchParams.delete("dl");
    url.searchParams.set("dl", "1");
    return { url: url.toString() };
  }
  if (host === "1drv.ms" || host === "onedrive.live.com") {
    // Kept as shared (file or folder): stock-pull asks OneDrive's share API for the file
    // itself, or for the newest stock file of a folder.
    url.searchParams.delete("download");
    return { url: url.toString() };
  }
  if (host.endsWith(".sharepoint.com")) {
    url.searchParams.set("download", "1");
    return { url: url.toString() };
  }
  return { url: url.toString() };
}
