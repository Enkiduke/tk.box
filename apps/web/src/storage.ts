// Read existing preferences once under their new name without resetting viewer choices.
export function readPreference(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string): string | null {
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    const legacyKey = key.replace(/^tk\.box(?=[.:])/, 'enki');
    if (legacyKey === key) return null;
    const legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      try { storage.setItem(key, legacy); storage.removeItem(legacyKey); } catch { /* Keep the saved choice even if writes are unavailable. */ }
    }
    return legacy;
  } catch { return null; }
}
