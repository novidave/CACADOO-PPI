/**
 * The shape of an access key for private folders (XXXX-XXXX-XXXX-XXXX-XXXX; A–Z without
 * I, L and O, digits 2–9). A chat message that is nothing but a key is checked as a key in
 * the shop's assistant and never sent to the AI or kept in the conversation.
 */
const KEY_SHAPE = /^[A-HJ-NP-Z2-9]{4}(?:[-\s]?[A-HJ-NP-Z2-9]{4}){4}$/i;

export function looksLikeKey(text: string): boolean {
  return KEY_SHAPE.test(text.trim());
}
