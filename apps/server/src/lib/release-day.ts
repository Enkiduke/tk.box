import { z } from 'zod';

const isoDay = z.iso.date();

export function releaseDay(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return undefined;
  const day = value.slice(0, 10);
  return isoDay.safeParse(day).success && day > '0001-01-01' ? day : undefined;
}

export function movieReleaseDate(movie: { digitalRelease?: unknown; physicalRelease?: unknown; inCinemas?: unknown }) {
  const digital = releaseDay(movie.digitalRelease), physical = releaseDay(movie.physicalRelease);
  if (digital && (!physical || digital <= physical)) return { format: 'digital', day: digital } as const;
  if (physical) return { format: 'physical', day: physical } as const;
  const theatrical = releaseDay(movie.inCinemas);
  if (theatrical) return { format: 'theatrical', day: theatrical } as const;
  return undefined;
}
