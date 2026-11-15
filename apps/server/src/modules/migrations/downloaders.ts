import type { Migration } from '../../persistence/migrate.js';

// SABnzbd and qBittorrent (docs/ARR-REPLACEMENT.md, "Data model" › downloaders). Secrets are sealed with the vault.
export const downloadersMigrations: Migration[] = [
  { name: 'downloaders', up: `
    CREATE TABLE downloaders(
      name TEXT PRIMARY KEY CHECK(name IN ('sabnzbd','qbittorrent')),
      url TEXT NOT NULL, sealed_secret TEXT,
      settings TEXT NOT NULL DEFAULT '{}'
    );` }
];
