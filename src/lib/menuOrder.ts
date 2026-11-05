/**
 * "Objednať" on a restaurant's Menu (update 80): the window event the Menu sends and the assistant (its loader or the
 * live chat) takes — the menu line's id (a dish or one size) and the question it sends. No imports: the assistant's
 * loader is part of every shop page's first load.
 */
export const MENU_ORDER_EVENT = "ppi:order";

export interface MenuOrderEvent {
  id: string;
  text: string;
}
