"use client";

import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** "Install PPI as an app" (Edge/Chrome) and how to start it with Windows. */
export function InstallApp({
  labels,
}: {
  labels: {
    install_title: string;
    install_intro: string;
    install_button: string;
    installed: string;
    install_manual: string;
    autostart_title: string;
    autostart_1: string;
    autostart_2: string;
    autostart_3: string;
    autostart_4: string;
    keep_awake: string;
  };
}) {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const update = () => setStandalone(media.matches);
    update();
    const onPrompt = (e: Event) => {
      e.preventDefault(); // show our own button instead of the browser's mini bar
      setInstallEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstallEvent(null);
    media.addEventListener("change", update);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice.catch(() => undefined);
    setInstallEvent(null);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="border-b border-line pb-1 text-lg font-semibold">{labels.install_title}</h2>
      <p className="text-sm">{labels.install_intro}</p>
      {standalone ? (
        <p className="font-semibold">{labels.installed}</p>
      ) : installEvent ? (
        <button type="button" onClick={install} className="self-start rounded border border-foreground px-4 py-2 font-medium">
          {labels.install_button}
        </button>
      ) : (
        <p className="text-sm text-muted">{labels.install_manual}</p>
      )}
      <div className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{labels.autostart_title}</span>
        <ol className="list-decimal pl-6">
          <li>{labels.autostart_1}</li>
          <li>{labels.autostart_2}</li>
          <li>{labels.autostart_3}</li>
          <li>{labels.autostart_4}</li>
        </ol>
      </div>
      <p className="text-sm text-muted">{labels.keep_awake}</p>
    </section>
  );
}
