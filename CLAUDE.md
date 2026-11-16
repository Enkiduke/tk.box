# tk.box

## Testing and verification

Keep checks minimal; the user tests the app themselves.

- Run `npm run typecheck` after code changes.
- Run only the test files that cover what you changed (`npx tsx --test tests/<file>.test.ts`). Do not run the full suite (`npm test`) unless asked.
- Add or update tests only where logic changed in a way that is easy to get wrong; skip tests for UI and copy changes.
- UI changes follow docs/UI.md and are built from `apps/web/src/manage-ui.tsx`. Look at them in the Plex preview before saying they're done: `npm run preview:plex` (launch config `plex-preview`, or `plex-preview-keep` to skip the sync) serves a read-only, frozen copy of the live server on port 3012. Check at desktop width. Don't start the app for anything else unless the user asks.
- Report what you ran and what you skipped.
