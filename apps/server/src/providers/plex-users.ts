import { z } from 'zod';

const id = z.union([z.string(), z.number().int().nonnegative()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/));
const account = z.object({
  id, title: z.string().nullish(), username: z.string().nullish(), home: z.boolean().nullish(),
  restricted: z.boolean().nullish(),
});
const people = z.array(account);
const serverShares = z.array(z.object({
  id, machineIdentifier: z.string(), invited: account.nullish(), invitedEmail: z.string().nullish(),
}));
const itemShares = z.array(z.object({
  id, status: z.string(), origin: z.string(), invited: account.nullish(), invitedEmail: z.string().nullish(),
  sharedItems: z.array(z.object({ id, uri: z.string().nullish() })),
}));

type Read = (path: string) => Promise<unknown>;
type Access = { path: string; pending: boolean; library: boolean };
type Person = {
  key: string;
  accountId: string | null;
  name: string;
  username?: string;
  home: boolean;
  managed: boolean;
  access: Access[];
};

export const canManageTkBox = (user: Person) => user.access.some(share => share.library && !share.pending);

export async function readPlexUsers(readCloud: Read, readAccount: Read, machineId: string) {
  const directory = Promise.allSettled([
    readAccount('/api/v2/friends').then(value => people.parse(value)),
    readAccount('/api/v2/home/users').then(value => Array.isArray(value) ? people.parse(value) : z.object({ users: people }).parse(value).users),
  ]);
  const [accepted, invitations, items, [friends, home]] = await Promise.all([
    readCloud('/api/v2/shared_servers/owned/accepted').then(value => serverShares.parse(value)),
    readCloud('/api/v2/shared_servers/invites/owned/pending').then(value => serverShares.parse(value)),
    readCloud('/api/v2/shared_sources/owned?includeItems=1').then(value => itemShares.parse(value)),
    directory,
  ]);
  const users = new Map<string, Person>();
  function addUser(profile: z.infer<typeof account>, inHome = false) {
    const existing = users.get(profile.id);
    const user: Person = {
      key: profile.id, accountId: profile.id, name: profile.title || existing?.name || profile.username || `Plex user ${profile.id}`,
      username: profile.username || existing?.username, home: inHome || !!profile.home || !!existing?.home,
      managed: !!profile.restricted || !!existing?.managed, access: existing?.access ?? [],
    };
    users.set(profile.id, user);
    return user;
  }
  function addAccess(share: { invited?: z.infer<typeof account> | null; invitedEmail?: string | null }, key: string, access: Access[]) {
    if (share.invited) {
      addUser(share.invited).access.push(...access);
    } else {
      users.set(key, { key, accountId: null, name: share.invitedEmail || 'Plex invitation', home: false, managed: false, access });
    }
  }

  for (const [shares, pending] of [[accepted, false], [invitations, true]] as const) {
    for (const share of shares) {
      if (share.machineIdentifier !== machineId) continue;
      addAccess(share, `share-${share.id}`, [{ path: `/api/v2/shared_servers/${share.id}`, pending, library: true }]);
    }
  }
  const onServer = (value?: string | null) => value === machineId || value === `server://${machineId}` || !!value?.startsWith(`server://${machineId}/`);
  for (const source of items) {
    if (source.status !== 'accepted' && source.status !== 'pending') continue;
    const access = source.sharedItems.filter(item => onServer(item.uri ?? source.origin)).map(item => ({
      path: `/api/v2/shared_items/${item.id}`, pending: source.status === 'pending', library: false,
    }));
    if (access.length) addAccess(source, `items-${source.id}`, access);
  }
  if (friends.status === 'fulfilled') for (const profile of friends.value) addUser(profile);
  if (home.status === 'fulfilled') for (const profile of home.value) addUser(profile, true);
  return { users, directoryIncomplete: friends.status === 'rejected' || home.status === 'rejected' };
}
