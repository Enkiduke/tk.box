import type { PlexAdapter } from '../../providers/plex.js';
import type { ArtworkCollections, ArtworkStore } from '../../persistence/artwork-store.js';
import type { CollectionsStore } from '../../persistence/collections-store.js';
import { AppError } from '../../errors.js';
import { Canceled, CollectionsEngine } from './engine.js';
import { CollectionError, validateAutomatic, validateCollections } from './rules.js';
import { collectionSource, type Tmdb } from './sources.js';

// The collections engine as the artwork job queue and routes use it: one job's command line (the same commands the
// Python script took: all, custom [--date], added, index build/added), Discover's answers and the checks before saving.
export type CollectionsRun = { token: string; libraries: { key: string; title: string; type: string }[] };
export type CollectionsJob = { args: string[]; run: CollectionsRun; say: (line: string) => void; signal: AbortSignal; created: (name: string, ratingKey: string) => void };

export class CollectionsRunner {
  constructor(private deps: { plex: PlexAdapter; tmdb: Tmdb; mdblistKey: () => string | undefined; artwork: ArtworkStore; store: CollectionsStore; transport?: typeof fetch }) {}
  private engine(run: CollectionsRun, say: (line: string) => void = () => {}, signal?: AbortSignal, created?: (name: string, ratingKey: string) => void) {
    const settings = this.deps.artwork.settings();
    return new CollectionsEngine({ plex: this.deps.plex, token: run.token, libraries: settings.libraries, tmdb: this.deps.tmdb, mdblistKey: this.deps.mdblistKey(),
      collections: this.deps.artwork.collectionsConfig(), upload: settings.upload, store: this.deps.store, say, signal, created, transport: this.deps.transport });
  }
  // One job; its exit code (0 when it went through, 1 when anything failed).
  async job({ args, run, say, signal, created }: CollectionsJob) {
    const engine = this.engine(run, say, signal, created);
    try {
      const [command, ...rest] = args;
      if (command === 'all' || command === 'custom') {
        const mode = rest[0] === 'apply' ? 'apply' : 'plan', at = rest.indexOf('--date'), date = at >= 0 ? rest[at + 1] : undefined;
        if (date && mode !== 'plan') throw new CollectionError('--date is only for plan');
        const today = date ? new Date(`${date}T12:00:00`) : new Date();
        return await engine.sync(mode, command === 'custom', today);
      }
      if (command === 'added') return await engine.added(rest[0]!);
      if (command === 'index' && rest[0] === 'build') return await engine.buildIndex() ? 1 : 0;
      if (command === 'index' && rest[0] === 'added') return await engine.indexAdded(rest.slice(1));
      throw new CollectionError(`Unknown collections command: ${args.join(' ')}`);
    } catch (e) {
      if (e instanceof Canceled) throw e;
      say(`ERROR: ${(e as Error).message}`);
      return 1;
    }
  }
  async discover(run: CollectionsRun, input: Record<string, unknown>) {
    try { return await this.engine(run).discover(input); }
    catch (e) { if (e instanceof CollectionError) throw new AppError('ARTWORK_REQUEST_FAILED', e.message, 422); throw e; }
  }
  // The collections' own checks of what is about to be saved.
  validate(collections: ArtworkCollections) {
    try { if (collections.definitions) validateCollections(collections.definitions, collectionSource); validateAutomatic(collections.automatic); }
    catch (e) { if (e instanceof CollectionError) throw new AppError('ARTWORK_CONFIG_INVALID', e.message, 422); throw e; }
  }
}
