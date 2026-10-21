"use client";

import { useState, type ReactNode } from "react";
import { youtubeEmbed, youtubeWatch } from "@/lib/video";

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

/** ▶ in black and white (no colours). */
export function PlayMark({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="drop-shadow" data-play-icon>
      <circle cx="32" cy="32" r="30" fill="white" fillOpacity="0.92" stroke="black" strokeOpacity="0.6" strokeWidth="2" />
      <path d="M26 20 L46 32 L26 44 Z" fill="black" />
    </svg>
  );
}
