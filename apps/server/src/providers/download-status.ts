// What a downloader says about one download, as grab states (docs/ARR-REPLACEMENT.md, "Clients"). Finished is
// `importing`: the import is next.
export type DownloadState = 'downloading' | 'unpacking' | 'importing' | 'failed';
export type DownloadStatus = {
  downloader: 'sabnzbd' | 'qbittorrent'; downloadId: string; name: string; category: string;
  state: DownloadState; progress?: number; size?: number;
  // SABnzbd's final folder, or the torrent's content path; and why it failed.
  storage?: string; error?: string;
  // qBittorrent only: its own state, whether that is waiting on qBittorrent rather than on peers (queued, paused,
  // checking), and the seeding figures.
  torrentState?: string; waiting?: boolean; ratio?: number; seedingSeconds?: number;
};
