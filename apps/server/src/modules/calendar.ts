import { defineModule } from './module.js';
import { registerCalendar } from '../calendar-api.js';
import type { CalendarLibrary } from '../calendar-api.js';
import type { PlexIndex } from '../services/plex-index.js';

type Deps = {
  // tk.box's library: the calendar's movies and episodes (TMDB's dates).
  library: CalendarLibrary;
  // The title identity: where each entry is on Plex, opened with the viewer's grant.
  plexTitles: Pick<PlexIndex, 'resolve'>;
};

// The release calendar: the library's movies and episodes matched to the viewer's Plex libraries, with TMDB season finales.
export const calendarModule = defineModule({
  name: 'calendar',
  portal: true,
  setup(routes, { plex, tmdb }, { library, plexTitles }: Deps) {
    registerCalendar(routes, plex, tmdb, library, plexTitles);
    return { api: {} };
  }
});
