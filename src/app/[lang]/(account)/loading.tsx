/**
 * Môj obchod while the next page is read (performance pass): the menu stays, grey bars stand where the sections will
 * be, so a tap on the menu answers at once. Public pages have none: their whole content is in the first HTML.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" data-loading>
      <div className="h-7 w-48 animate-pulse rounded bg-line/60" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 border-b border-line py-3">
          <div className="h-5 w-56 animate-pulse rounded bg-line/60" />
          <div className="h-4 w-full max-w-md animate-pulse rounded bg-line/40" />
        </div>
      ))}
    </div>
  );
}
