"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { MenuTools as Tools } from "./MenuTools";

// Its own chunk (a dynamic import inside a Client Component): only a restaurant's page loads the Menu's search and
// "Objednať" code; every shop page shares this route, and its first load stays under the 150 kB budget.
const MenuTools = dynamic(() => import("./MenuTools").then((m) => m.MenuTools));

/** "Hľadať v menu" and "Objednať" (update 80), drawn on the server as well (the search form works without JavaScript). */
export function MenuToolsLazy(props: ComponentProps<typeof Tools>) {
  return <MenuTools {...props} />;
}
