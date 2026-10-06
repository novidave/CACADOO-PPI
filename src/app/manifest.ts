import type { MetadataRoute } from "next";

/**
 * Makes PPI installable (Edge/Chrome → "Install as app"), so the shop PC can start
 * it with Windows. It opens on the export-folder page (/sync → the visitor's language).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/sync",
    name: "PPI",
    short_name: "PPI",
    description: "PPI – sends the shop's stock file to PPI every 15 minutes while open.",
    start_url: "/sync",
    scope: "/",
    display: "standalone",
    // Starting it again (e.g. at Windows sign-in) focuses the open window instead of a second one.
    launch_handler: { client_mode: "focus-existing" },
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
