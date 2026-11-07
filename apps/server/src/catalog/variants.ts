/**
 * Duplicate channels: panels carry the same channel many times ("BBC One HD", "BBC One FHD",
 * "BBC One RAW", "BBC One ᴴᴰ"). After each catalog sync the channels are grouped by name
 * (names.variantKey) and language; each channel gets its group key, its quality and its rank in
 * the group (0 = the one lists show). A variant without a guide id borrows the group's, so the
 * whole group shows the same guide.
 *
 * Lists and search show one channel per group when the profile's "merge duplicate channels"
 * setting is on: the best ranked one the profile can see (see store.variantClause), so hiding a
 * category or a country never hides a whole group that still has a visible variant.
 */
import type { Db } from '../db';
import { variantKey, variantScore, type Quality } from './names';

interface Row { id: string; name: string; language: string | null; number: number; archive_days: number; epg_channel_id: string | null }

export function groupVariants(db: Db): { groups: number; merged: number } {
  const rows = db.prepare('SELECT id, name, language, number, archive_days, epg_channel_id FROM channels').all() as Row[];
  const groups = new Map<string, { row: Row; quality: Quality; base: string; score: number }[]>();
  for (const r of rows) {
    const v = variantKey(r.name);
    const key = `${r.language ?? '-'}|${v.key}`;
    const list = groups.get(key) ?? [];
    list.push({ row: r, quality: v.quality, base: v.base, score: variantScore({ quality: v.quality, archiveDays: r.archive_days, spare: v.spare }) });
    groups.set(key, list);
  }
  const update = db.prepare(
    `UPDATE channels SET group_key = ?, group_name = ?, group_number = ?, quality = ?, variant_rank = ?, group_size = ?, epg_channel_id = ?
     WHERE id = ? AND (group_key IS NOT ? OR group_name IS NOT ? OR group_number != ? OR quality IS NOT ? OR variant_rank != ? OR group_size != ? OR epg_channel_id IS NOT ?)`,
  );
  let merged = 0;
  db.transaction(() => {
    for (const [key, list] of groups) {
      list.sort((a, b) => a.score - b.score || a.row.number - b.row.number || a.row.id.localeCompare(b.row.id));
      const guide = list.find((v) => v.row.epg_channel_id)?.row.epg_channel_id ?? null;
      // the group's name: the best version's name without its quality tags ("BBC One")
      const name = list[0]!.base;
      // and its place in the channel list: the lowest number of its versions
      const number = Math.min(...list.map((v) => v.row.number));
      if (list.length > 1) merged += list.length - 1;
      list.forEach((v, rank) => {
        const epg = v.row.epg_channel_id ?? guide;
        update.run(key, name, number, v.quality, rank, list.length, epg, v.row.id, key, name, number, v.quality, rank, list.length, epg);
      });
    }
  })();
  return { groups: groups.size, merged };
}

/** Groups the channels again when the catalog was synced before grouping existed. */
export function ensureVariants(db: Db): void {
  const missing = db.prepare('SELECT 1 FROM channels WHERE group_key IS NULL LIMIT 1').get();
  if (missing) groupVariants(db);
}
