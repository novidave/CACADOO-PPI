/** ▶ in black and white (no colours). */
export function PlayMark({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="drop-shadow" data-play-icon>
      <circle cx="32" cy="32" r="30" fill="white" fillOpacity="0.92" stroke="black" strokeOpacity="0.6" strokeWidth="2" />
      <path d="M26 20 L46 32 L26 44 Z" fill="black" />
    </svg>
  );
}
