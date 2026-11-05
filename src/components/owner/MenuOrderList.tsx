"use client";

import { useState } from "react";
import { buttonClass } from "./ui";

/**
 * The order of the menu's categories or of a category's dishes (update 80): drag a row (a computer) or ▲ ▼ (every
 * device, the keyboard too), then "Uložiť poradie" sends every id in the new order (owner_menu_order_categories /
 * owner_menu_order_items decide). Nothing moves on the public Menu before the save.
 */
export function MenuOrderList({
  action,
  hidden,
  items,
  labels,
}: {
  action: (formData: FormData) => Promise<void>;
  hidden: Record<string, string>;
  items: { id: string; name: string }[];
  labels: { up: string; down: string; drag: string; save: string };
}) {
  const [order, setOrder] = useState(items);
  const [dragging, setDragging] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
  };
  const changed = order.some((item, i) => item.id !== items[i]?.id);
  return (
    <form action={action} className="flex flex-col gap-2" data-menu-order-list>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="ids" value={JSON.stringify(order.map((i) => i.id))} />
      <p className="text-[13px] text-muted">{labels.drag}</p>
      <ol className="flex flex-col gap-1.5">
        {order.map((item, i) => (
          <li
            key={item.id}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragging !== null && dragging !== i) {
                move(dragging, i);
                setDragging(i);
              }
            }}
            onDragEnd={() => setDragging(null)}
            className={`flex min-h-[52px] items-center gap-2 rounded-xl border border-[#E4E4E4] bg-white px-3 ${dragging === i ? "opacity-60" : ""}`}
            data-order-item={item.id}
          >
            <span aria-hidden="true" className="cursor-grab text-muted select-none">
              ⠿
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
            <button type="button" className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#E4E4E4] disabled:opacity-30" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`${labels.up}: ${item.name}`}>
              ▲
            </button>
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#E4E4E4] disabled:opacity-30"
              onClick={() => move(i, i + 1)}
              disabled={i === order.length - 1}
              aria-label={`${labels.down}: ${item.name}`}
            >
              ▼
            </button>
          </li>
        ))}
      </ol>
      <button type="submit" className={`${buttonClass} self-start`} disabled={!changed} data-order-save>
        {labels.save}
      </button>
    </form>
  );
}
