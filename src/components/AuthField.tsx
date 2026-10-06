/** One labelled input of the login / sign-up / password forms. */
export function AuthField({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      <input {...input} className="rounded border border-line px-3 py-2 outline-none focus:border-foreground" />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function AuthNotice({ text, strong }: { text: string; strong?: boolean }) {
  return <p className={strong ? "border border-foreground p-3 font-medium" : "border border-line p-3"}>{text}</p>;
}
