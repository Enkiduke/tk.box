# tk.box

## Testing and verification

Keep checks minimal. The user tests the app and performs all visual review.

- Run `npm run typecheck` after code changes.
- Run only the test files that cover the changes with `npx tsx --test tests/<file>.test.ts`. Run the full suite (`npm test`) only when the user asks.
- Add or update tests only for logic changes that are easy to get wrong. Skip new tests for UI and copy changes.
- Leave visual testing to the user. Start the app for visual verification, open a browser preview, control a browser or desktop app, capture screenshots, or run visual tests only when the user explicitly asks for that check in the current task. Describe the UI changes so the user can verify them.
- Report which checks you ran and which you skipped.
