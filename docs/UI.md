# UI rules (Admin)

What every Admin page follows. The pieces live in `apps/web/src/manage-ui.tsx` and `apps/web/src/ui.css`; a page is
built from them, never from one-off markup. Desktop width first (no phone compromises). Look at a change in the Plex
preview (`npm run preview:plex`, real data, read-only) and screenshot it before calling it done.

## Page
1. **Header**: the page name (`SectionHead`), with at most one or two page-wide actions on its right.
2. **One bar** under it: either `Tabs` (views of the same thing, each with its count) or a `Toolbar` (search,
   segmented filters, the count on the right). Never both stacked, never a second bar. Filters are always segmented
   buttons (`Segmented`), never dropdowns; tables sort by their headers.
3. **Content**: `Panel`s. A panel holds a table flush to its edges, or settings rows. No stacked full-width cards of
   lists: a page with several lists shows one at a time through `Tabs`.

## Sizes
- Spacing on a 4 px grid: 4, 8, 12, 16, 24, 32.
- Every control in a bar is 36 px tall (search, segmented, select, button).
- Table header 36 px; rows 52 px with a poster, 44 px without. Posters in tables are 24 × 36.
- Text: body 13–14 px; a row's second line 12 px muted, one line, cut with an ellipsis; column headers 11 px caps, dim.

## Tables (`Table`)
- Columns have fixed widths (set in the page's column list), so the same column lines up on every page:
  title flexible; quality 130; size 90 (right); a time 110; a count 80 (right); status 130; actions 96.
- Numbers right-aligned in tabular figures. An empty value is a dim "—"; a column that would be mostly empty is
  left out, or folded into the title's second line.
- Row actions are icon buttons on the right, shown on hover or focus (`RowActions`). Each has a tooltip.
- A row opens its thing when its title is clicked. A movie or show opens as a dialog over the page you're on
  (`MovieDialog`, `&title=<id>`, `&pane=files|grabs|requests|search` for a tab, `&scope=S02` or `S02E05` for a show's
  search), never a page of its own, so the list stays as you left it. Its head holds the facts and the settings strip
  (`TitleControls`: Monitored, Profile, Favorite, the searches); the tabs hold one table each (a show's Seasons first,
  a movie's Files). A show's seasons are rows that open to their episodes.
- A row with a history opens to it (Downloads › History: one row per grab, its status the outcome): a chevron button
  (`ui-expand`) or a click on the row shows a full-width detail row with its steps (`ui-steps`), oldest first.
- A show's grab or file names its episodes in a tag: `S02` for a whole season, `S02E05`, `S02E05–E07`.
- Every list table sorts by clicking a header (`useSorted`): once by that column, again reversed, a third time back
  to the table's own order. Sizes, qualities, scores and times start biggest or newest first; quality sorts by the
  ladder, and empty values always go last.
- Lists over 100 rows show 100, then "Show 100 more". Movies and Shows load the next 100 on their own as you scroll near the end (`usePaged(…, {auto:true})`).

## Status (`Pill`)
One coloured pill (dot + word) per state, the same everywhere:

| Tone | Colour | States |
| --- | --- | --- |
| `ok` | green | Imported, Available, Done, Accepted |
| `active` | blue | Downloading, Sending, Unpacking, Importing, Seeding, Running |
| `wait` | amber | Waiting, Queued, Missing, Below cutoff |
| `bad` | red | Failed, Rejected, Banned, Failing (a title stopped after repeated failed downloads; Resume clears it) |
| `off` | grey | Paused (a download client), Not monitored, Not aired, Cancelled |

Error text goes on the row's second line in red, not as a whole red column.

## Forms (`Field`)
- Settings are rows: a label (and a short hint) on the left, 240 px, and the control on the right.
- Save and Cancel appear in the panel's footer only once something changed (`SaveBar`). A save that started from an
  old version says "Someone saved this first" with Reload.
- Inline checks show under the control as you type; Save is off while any is failing.

## Copy
Terse: titles and controls, no descriptions on panels (see the terse-copy rule). Times are "in 3 h" / "2 d ago",
the exact date on hover.
