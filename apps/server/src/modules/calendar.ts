import { defineModule } from './module.js';
import { registerCalendar } from '../calendar-api.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { CalendarLibrary } from '../calendar-api.js';

type Deps = {
  // Sonarr, from the arr module.
  sonarr: () => ArrService;
  titles: TmdbTitles;
  // tk.box's library: the calendar's movies (TMDB's dates).
  library: CalendarLibrary;
};

// The release calendar: the library's movies and Sonarr's episodes matched to the viewer's Plex libraries, with TMDB season finales.
export const calendarModule = defineModule({
  name: 'calendar',
  portal: true,
  setup(routes, { plex }, { sonarr, titles, library }: Deps) {
    registerCalendar(routes, plex, sonarr, undefined, titles, library);
    return { api: {} };
  }
});
