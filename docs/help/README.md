# Pomocník — help articles

Short help articles for the owner's AI pomocník (the website's panel and the Telegram bot). Each file is one topic:
front matter `title`, `link` (a Cacaduu screen, without the language: `/dashboard/...`) and `words` (extra search words),
then the text in Slovak, as the owner would read it. The AI answers in the owner's language from these texts only.

After changing a file run `node scripts/assistant-core.mjs` (it writes the topics into `src/lib/ownerAssistantCore.ts`
and copies the engine into the Telegram function); `npm run test:telegram` fails when they differ.
