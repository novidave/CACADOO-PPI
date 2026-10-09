/**
 * The shop's e-mail and Facebook page as small black icons with text, shown next to the
 * website link. E-mail opens the visitor's mail program; Facebook opens in a new tab.
 */
export function ContactLinks({
  email,
  facebookUrl,
  facebookLabel,
}: {
  email: string | null;
  facebookUrl: string | null;
  facebookLabel: string;
}) {
  return (
    <>
      {email && (
        <a href={`mailto:${email}`} className="inline-flex items-center gap-1" data-contact="email">
          <MailIcon />
          <span className="underline underline-offset-4">{email}</span>
        </a>
      )}
      {facebookUrl && (
        <a
          href={facebookUrl}
          className="inline-flex items-center gap-1"
          target="_blank"
          rel="noopener"
          data-contact="facebook"
        >
          <FacebookIcon />
          <span className="underline underline-offset-4">{facebookLabel}</span>
        </a>
      )}
    </>
  );
}

function MailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="m3.5 6 8.5 7 8.5-7" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.8 1.4-3.8 3.9v2.3H7.9v3h2.6V21h3Z" />
    </svg>
  );
}
