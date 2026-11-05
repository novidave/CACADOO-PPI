"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * "Náhľad menu" (update 80): the public Menu as the shop page draws it, at a phone's (390 px) and a computer's (the
 * page's 760 px column) width, each scaled down to fit the owner's column (never cut, never scrolled sideways).
 */
export function MenuPreview({ children, labels }: { children: ReactNode; labels: { phone: string; computer: string } }) {
  return (
    <div className="flex flex-col gap-4" data-menu-preview>
      <Frame width={390} label={labels.phone}>
        {children}
      </Frame>
      <Frame width={760} label={labels.computer}>
        {children}
      </Frame>
    </div>
  );
}

function Frame({ width, label, children }: { width: number; label: string; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ scale: 1, height: 0 });
  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const scale = Math.min(1, o.clientWidth / width);
      setSize({ scale, height: i.scrollHeight * scale });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    measure();
    return () => ro.disconnect();
  }, [width]);
  return (
    <figure className="flex flex-col gap-1.5" data-preview-frame={width}>
      <figcaption className="text-sm font-semibold">{label}</figcaption>
      <div ref={outer} className="overflow-hidden rounded-2xl border border-[#E4E4E4] bg-[#FFF8F0]" style={{ height: size.height || undefined }} inert>
        <div ref={inner} className="p-4" style={{ width, transform: `scale(${size.scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
    </figure>
  );
}
