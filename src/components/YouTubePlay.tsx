"use client";

import { useState, type ReactNode } from "react";
import { youtubeEmbed, youtubeWatch } from "@/lib/video";
import { PlayMark } from "./PlayMark";

export { PlayMark };

/**
 * A YouTube video on a blog post (update 39): its picture (stored in Cacaduu) with a ▶; nothing loads from YouTube
 * until the visitor taps it, then the player (youtube-nocookie) replaces the picture and starts. Without JavaScript
 * the link opens the video on YouTube.
 */
export function YouTubePlay({ id, label, title, className, children }: { id: string; label: string; title: string; className?: string; children: ReactNode }) {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <div className={`relative aspect-video w-full ${className ?? ""}`} data-youtube-player>
        <iframe
          src={youtubeEmbed(id)}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full border border-line"
        />
      </div>
    );
  }
  return (
    <a
      href={youtubeWatch(id)}
      target="_blank"
      rel="noopener"
      onClick={(e) => {
        e.preventDefault();
        setPlaying(true);
      }}
      aria-label={label}
      className={`relative block ${className ?? ""}`}
      data-youtube-play={id}
    >
      {children}
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <PlayMark />
      </span>
      <span className="absolute bottom-2 left-2 bg-white px-2 py-1 text-sm font-medium">{label}</span>
    </a>
  );
}

