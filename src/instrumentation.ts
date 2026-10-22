import type { Instrumentation } from "next";
import { describeError, reportServerError } from "@/lib/errorLog";

/** Every server error (pages, API routes, server actions, the proxy) → the error log; no personal data (errorLog.ts). */
export const onRequestError: Instrumentation.onRequestError = async (err, _request, context) => {
  await reportServerError(describeError(err, context.routePath, context.routeType));
};
