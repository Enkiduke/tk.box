import { defineModule } from './module.js';
import { registerCalendar } from '../calendar-api.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { CalendarLibrary } from '../calendar-api.js';

type Deps = {
  titles: TmdbTitles;
  // tk.box's library: the calendar's movies and episodes (TMDB's dates).
  library: CalendarLibrary;
};

// The release calendar: the library's movies and episodes matched to the viewer's Plex libraries, with TMDB season finales.
export const calendarModule = defineModule({
  name: 'calendar',
  portal: true,
  setup(routes, { plex }, { titles, library }: Deps) {
    registerCalendar(routes, plex, titles, library);
    return { api: {} };
  }
});
