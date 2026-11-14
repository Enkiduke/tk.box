import { z } from 'zod';

const id = z.union([z.string(), z.number().int().nonnegative()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/));
const account = z.object({
  id, title: z.string().nullish(), username: z.string().nullish(), home: z.boolean().nullish(),
  restricted: z.boolean().nullish(),
});
const people = z.array(account);
const serverShare = z.object({ id, machineIdentifier: z.string() });
const recipient = z.object({ invited: account.nullish(), invitedEmail: z.string().nullish() });
const serverShares = z.array(serverShare.extend(recipient.shape));
const invitations = z.array(recipient.extend({ sharedServers: z.array(serverShare) }));
const itemSource = z.object({ id, origin: z.string().nullish(), sharedItems: z.array(z.object({ id, uri: z.string().nullish() })) });
const itemShares = z.array(itemSource.extend({ ...recipient.shape, status: z.string() }));
const itemInvitations = z.array(recipient.extend({ sharedSources: z.array(itemSource.partial({ sharedItems: true })) }));

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
  const [accepted, pending, items, pendingItems, [friends, home]] = await Promise.all([
    readCloud('/api/v2/shared_servers/owned/accepted').then(value => serverShares.parse(value)),
    readCloud('/api/v2/shared_servers/invites/owned/pending').then(value => invitations.parse(value)),
    readCloud('/api/v2/shared_sources/owned?includeItems=1').then(value => itemShares.parse(value)),
    readCloud('/api/v2/shared_sources/invites/owned/pending').then(value => itemInvitations.parse(value)),
    directory,
  ]);
  const users = new Map<string, Person>();
  function addUser(profile: z.infer<typeof account>, inHome = false) {
    const existing = users.get(profile.id);
    const user: Person = {
      key: profile.id, accountId: profile.id, name: profile.title || existing?.name || profile.username || `Plex user ${profile.id}`,
      username: profile.username || existing?.username, home: inHome || !!profile.home || !!profile.restricted || !!existing?.home,
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

  for (const share of accepted) {
    if (share.machineIdentifier !== machineId) continue;
    addAccess(share, `share-${share.id}`, [{ path: `/api/v2/shared_servers/${share.id}`, pending: false, library: true }]);
  }
  for (const invite of pending) {
    const shares = invite.sharedServers.filter(share => share.machineIdentifier === machineId);
    if (shares.length) addAccess(invite, `share-${shares[0]!.id}`, shares.map(share => ({
      path: `/api/v2/shared_servers/${share.id}`, pending: true, library: true,
    })));
  }
  const onServer = (value?: string | null) => value === machineId || value === `server://${machineId}` || !!value?.startsWith(`server://${machineId}/`);
  function itemAccess(source: z.infer<typeof itemSource>, pending: boolean): Access[] {
    return source.sharedItems.filter(item => onServer(item.uri ?? source.origin)).map(item => ({
      path: `/api/v2/shared_items/${item.id}`, pending, library: false,
    }));
  }
  for (const source of items) {
    if (source.status !== 'accepted') continue;
    const access = itemAccess(source, false);
    if (access.length) addAccess(source, `items-${source.id}`, access);
  }
  for (const invite of pendingItems) {
    for (const source of invite.sharedSources) {
      const access = source.sharedItems?.length ? itemAccess({ ...source, sharedItems: source.sharedItems }, true) : [];
      if (onServer(source.origin) && (!source.sharedItems?.length || source.sharedItems.length === access.length)) {
        addAccess(invite, `items-${source.id}`, [{ path: `/api/v2/shared_sources/${source.id}`, pending: true, library: false }]);
        continue;
      }
      if (access.length) addAccess(invite, `items-${source.id}`, access);
    }
  }
  if (friends.status === 'fulfilled') for (const profile of friends.value) addUser(profile);
  if (home.status === 'fulfilled') for (const profile of home.value) addUser(profile, true);
  return { users, directoryIncomplete: friends.status === 'rejected' || home.status === 'rejected' };
}
