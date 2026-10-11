// Every function is pasted into Supabase's editor by hand (SETUP.md). Invisible or special
// characters written straight into the code (U+FFFF, a byte order mark, no-break spaces,
// zero-width or control characters) can change on the way and stop the function from starting
// ("worker boot error: Invalid regular expression"). Write them as escapes (\uffff) instead.
// Run: npm run test:functions

const RISKY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00a0\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202f\u2060-\u2064\ufeff\ufdd0-\ufdef\ufff0-\uffff\ud800-\udfff]/u;

Deno.test("every function can be pasted into the Supabase editor as it is", async () => {
  const problems: string[] = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (!entry.isDirectory) continue;
    let source: string;
    try {
      source = await Deno.readTextFile(new URL(`./${entry.name}/index.ts`, import.meta.url));
    } catch {
      continue;
    }
    source.split("\n").forEach((line, i) => {
      const found = RISKY.exec(line);
      if (found) {
        const code = found[0].codePointAt(0)!.toString(16).padStart(4, "0");
        problems.push(`${entry.name}/index.ts:${i + 1}: U+${code.toUpperCase()} – write it as \\u${code}`);
      }
    });
  }
  if (problems.length) throw new Error(`characters that can change when pasted:\n  ${problems.join("\n  ")}`);
});
