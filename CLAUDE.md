# tk.box

## Testing and verification

Keep checks minimal; the user tests the app themselves.

- Run `npm run typecheck` after code changes.
- Run only the test files that cover what you changed (`npx tsx --test tests/<file>.test.ts`). Do not run the full suite (`npm test`) unless asked.
- Add or update tests only where logic changed in a way that is easy to get wrong; skip tests for UI and copy changes.
- Do not start the app, open the browser preview or take screenshots to verify UI changes. Say what changed and let the user check it. Only use the preview when the user asks, or when you cannot otherwise tell whether something works.
- Report what you ran and what you skipped.
