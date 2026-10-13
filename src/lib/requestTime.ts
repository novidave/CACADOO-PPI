import "server-only";
import { cache } from "react";

/**
 * The moment this page is rendered on the server (one value per request): the first status
 * shown, which the browser then recomputes with its own clock right away and every minute.
 */
export const requestTime = cache((): number => Date.now());
