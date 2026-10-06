/** European IANA time zones (plus UTC) for the shop form. */
export function europeanTimeZones(): string[] {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z.startsWith("Europe/"))];
  } catch {
    return ["UTC", "Europe/Bratislava", "Europe/Budapest", "Europe/Prague", "Europe/Vienna", "Europe/Warsaw", "Europe/Berlin"];
  }
}
