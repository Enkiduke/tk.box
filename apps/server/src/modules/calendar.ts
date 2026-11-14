import { defineModule } from './module.js';
import { registerCalendar } from '../calendar-api.js';
import type { ArrService } from '../providers/arr-tags.js';
import type { TmdbTitles } from '../providers/tmdb-titles.js';

type Deps = {
  // Radarr and Sonarr, from the arr module.
  connections: () => { radarr: ArrService; sonarr: ArrService };
  titles: TmdbTitles;
};

// The release calendar: Radarr and Sonarr schedules matched to the viewer's Plex libraries, with TMDB season finales.
export const calendarModule = defineModule({
  name: 'calendar',
  setup(routes, { plex }, { connections, titles }: Deps) {
    registerCalendar(routes, plex, connections, undefined, titles);
    return { api: {} };
  }
});
