import { defineModule } from './module.js';
import { registerCalendar } from '../calendar-api.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';
import type { CalendarLibrary } from '../calendar-api.js';

type Deps = {
  // Radarr and Sonarr, from the arr module.
  connections: () => { radarr: ArrService; sonarr: ArrService };
  titles: TmdbTitles;
  // tk.box's library: with movies on tk.box, the calendar's movies are its own (TMDB's dates), not Radarr's.
  library?: CalendarLibrary;
};

// The release calendar: Radarr (or, with movies on tk.box, its library) and Sonarr schedules matched to the viewer's Plex libraries, with TMDB season finales.
export const calendarModule = defineModule({
  name: 'calendar',
  portal: true,
  setup(routes, { plex }, { connections, titles, library }: Deps) {
    registerCalendar(routes, plex, connections, undefined, titles, library);
    return { api: {} };
  }
});
