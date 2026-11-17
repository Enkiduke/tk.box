// What a downloader says about one download, as grab states (docs/ARR-REPLACEMENT.md, "Clients"). Finished is
// `importing`: the import is next.
export type DownloadState = 'downloading' | 'unpacking' | 'importing' | 'failed';
export type DownloadStatus = {
  downloader: 'sabnzbd' | 'qbittorrent'; downloadId: string; name: string; category: string;
  state: DownloadState; progress?: number; size?: number;
  // SABnzbd's final folder, or the torrent's content path; and why it failed.
  storage?: string; error?: string;
  // Bytes still to download, and whether the downloader itself holds it (queued, paused, checking): the download
  // health rules (docs/STALLS.md) don't judge a download that waits on its own client.
  left?: number; waiting?: boolean;
  // qBittorrent only: its own state, the seeding figures, the seeds connected and in the whole swarm (the tracker's
  // count), its availability (distributed copies) and whether it is still fetching metadata.
  torrentState?: string; ratio?: number; seedingSeconds?: number;
  seeds?: number; swarmSeeds?: number; availability?: number; metadata?: boolean;
  // SABnzbd only: its own word for a queued job (downloading, grabbing, fetching…), lower case.
  stage?: string;
};
// A downloader's own health, asked only when a download looks dead or slow: whether it is connected at all, and
// whether its alternative (slower) speed limits are on.
export type ClientCheck = { connected: boolean; throttled: boolean };
