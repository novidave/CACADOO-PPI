/**
 * The shop's amenities as green pills (Screen 11, at the owner's request 2026-10-31): only those the shop has, each
 * with its icon (decorative) and its name in words. Shop profile data, never stock. A server component.
 */
export function AmenityPills({ items, label }: { items: { key: "toilet" | "douchette" | "card"; text: string }[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label} data-amenities>
      {items.map((item) => (
        <li key={item.key} className="ppi-amenity" data-amenity={item.key}>
          <AmenityIcon kind={item.key} />
          {item.text}
        </li>
      ))}
    </ul>
  );
}

function AmenityIcon({ kind }: { kind: "toilet" | "douchette" | "card" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };
  if (kind === "toilet")
    return (
      <svg {...common}>
        <path d="M6 3.5h6.5a1 1 0 011 1V10H6z" />
        <path d="M8.5 6h2" />
        <path d="M4 10h16.5v.5a6.5 6.5 0 01-6.5 6.5h-3.5A6.5 6.5 0 014 10.5z" />
        <path d="M8.5 17l-.7 3.5h7.4L14.5 17" />
      </svg>
    );
  if (kind === "douchette")
    return (
      <svg {...common}>
        <path d="M9.5 3.5h5.2a1.6 1.6 0 011.6 1.6v.6a1.6 1.6 0 01-1.6 1.6H12.5" />
        <path d="M9.5 3.5a2 2 0 00-2 2v3.8l1.6 1.2h2l.9-3.3" />
        <path d="M11.4 5.2l-1.6 3.1" />
        <path d="M8.3 10.5v1.6c0 2.6-3.3 2.4-3.3 5.2 0 2.4 2.2 3.2 4.3 3.2h3.2" />
        <path d="M12.5 19v3M11 20.5h3" />
        <path d="M18.3 5.4l1.7-.6M18.6 7.6l1.6.7M18.3 3.4l1.4-1.1" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </svg>
  );
}
