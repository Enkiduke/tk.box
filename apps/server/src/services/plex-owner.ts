import { AppError } from '../errors.js';
import type { PlexAdapter, PlexGrant } from '../providers/plex.js';
import type { PlexBackground } from './plex-background.js';

// The server owner's Plex grant for work no viewer started (ModuleContext.plexOwner), from the Plex admin token saved
// in Admin › Connections. `grant` is undefined without a working token, for work that waits quietly; `require` throws
// for work someone is waiting on; `scanFolder` asks Plex to scan one folder with it (false when no library holds it).
// `upgradedMovie` waits for Plex to have a movie's new file, and can move it to the top of Recently Added (PlexAdapter.upgradedMovie).
// `check` vouches for a token before Admin › Connections saves it, and `invalidate` drops the grant after a save.
export type PlexOwner = {
  grant(): Promise<PlexGrant | undefined>;
  require(): Promise<PlexGrant>;
  scanFolder(folder: string): Promise<boolean>;
  upgradedMovie(ratingKey: string, fileName: string, resurface: boolean): Promise<'done' | 'waiting'>;
  check(token: string): Promise<PlexGrant>;
  invalidate(): void;
};

export const NO_PLEX_TOKEN = 'No Plex admin token in Admin › Connections.';

export function plexOwner(background: Pick<PlexBackground, 'grant' | 'check' | 'invalidate'>, plex: Pick<PlexAdapter, 'scanFolder'> & Partial<Pick<PlexAdapter, 'upgradedMovie'>>): PlexOwner {
  const require = async () => {
    const grant = await background.grant();
    if (!grant) throw new AppError('NO_PLEX_TOKEN', NO_PLEX_TOKEN, 409);
    return grant;
  };
  return {
    grant: () => background.grant(),
    require,
    async scanFolder(folder) { return plex.scanFolder((await require()).serverToken, folder); },
    async upgradedMovie(ratingKey, fileName, resurface) {
      if (!plex.upgradedMovie) throw new Error('Plex can’t be asked about upgrades here.');
      return plex.upgradedMovie((await require()).serverToken, ratingKey, fileName, resurface);
    },
    check: token => background.check(token),
    invalidate: () => background.invalidate()
  };
}
