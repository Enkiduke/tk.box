// Values kept for a while, at most `max` of them: past that, the oldest written go first. A hit doesn't refresh an
// entry's age. Expired entries are skipped on read and replaced on the next write (`prune` drops them all).
export class TtlCache<V> {
  private entries = new Map<string, { value: V; until: number }>();
  constructor(private max: number, private now: () => number = Date.now) {}
  get size() { return this.entries.size; }
  get(key: string, now = this.now()): V | undefined {
    const hit = this.entries.get(key);
    return hit && hit.until > now ? hit.value : undefined;
  }
  set(key: string, value: V, ttlMs: number, now = this.now()) {
    this.entries.delete(key); this.entries.set(key, { value, until: now + ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  // The cached value, or `make()` kept for `ttlMs`. Callers asking at the same time share one pending promise; a
  // promise that rejects is dropped (if it is still the one cached), so the next call tries again.
  remember<T extends V>(key: string, ttlMs: number, make: () => T, now = this.now()): T {
    const hit = this.entries.get(key);
    if (hit && hit.until > now) return hit.value as T;
    const value = make();
    this.set(key, value, ttlMs, now);
    if (value instanceof Promise) value.catch(() => { if (this.entries.get(key)?.value === value) this.entries.delete(key); });
    return value;
  }
  delete(key: string) { this.entries.delete(key); }
  deleteWhere(match: (key: string) => boolean) { for (const key of [...this.entries.keys()]) if (match(key)) this.entries.delete(key); }
  clear() { this.entries.clear(); }
  prune(now = this.now()) { for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key); }
}
