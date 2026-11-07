/**
 * Channel lists (LB-3): optimistic changes, the server's answer wins. While our own writes are in
 * flight, 'lists' events (which may describe an older state) are held back, so a quick series of
 * drags never flickers back to an earlier order.
 */
import type { ChannelList, MediaList } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { moveItem, toggleId } from '../lib/reorder';
import { useApp, type AddToListTarget } from './app';
import { toast } from './actions';

const get = useApp.getState;
const set = useApp.setState;

let inFlight = 0;
let heldEvent: ChannelList[] | null = null;

export function applyListsEvent(lists: ChannelList[]) {
  if (inFlight > 0) heldEvent = lists;
  else set({ lists });
}

async function write<T>(optimistic: ChannelList[] | null, req: () => Promise<T>, onOk: (res: T) => void, what: string): Promise<T | null> {
  const before = get().lists;
  if (optimistic) set({ lists: optimistic });
  inFlight++;
  try {
    const res = await req();
    onOk(res);
    return res;
  } catch (e) {
    set({ lists: before });
    toast(`Couldn't ${what}: ${errorMessage(e)}`, 'error');
    return null;
  } finally {
    inFlight--;
    if (inFlight === 0 && heldEvent) {
      set({ lists: heldEvent });
      heldEvent = null;
    }
  }
}

const replace = (list: ChannelList) => set((s) => ({ lists: s.lists.some((l) => l.id === list.id) ? s.lists.map((l) => (l.id === list.id ? list : l)) : [...s.lists, list] }));

export function createList(name: string, channelIds: string[] = []): Promise<ChannelList | null> {
  return write(null, () => call('POST /api/lists', { body: { name, channelIds } }), replace, 'create the list');
}

export function renameList(id: string, name: string) {
  const next = get().lists.map((l) => (l.id === id ? { ...l, name } : l));
  return write(next, () => call('PATCH /api/lists/:id', { params: { id }, body: { name } }), replace, 'rename the list');
}

export function deleteList(id: string) {
  const next = get().lists.filter((l) => l.id !== id);
  return write(next, () => call('DELETE /api/lists/:id', { params: { id } }), () => {}, 'delete the list');
}

export function setListChannels(id: string, channelIds: string[]) {
  const next = get().lists.map((l) => (l.id === id ? { ...l, channelIds } : l));
  return write(next, () => call('PUT /api/lists/:id/channels', { params: { id }, body: { channelIds } }), replace, 'update the list');
}

export function toggleInList(listId: string, channelId: string, on: boolean) {
  const list = get().lists.find((l) => l.id === listId);
  if (!list) return Promise.resolve(null);
  return setListChannels(listId, toggleId(list.channelIds, channelId, on));
}

export function moveChannel(listId: string, from: number, to: number) {
  const list = get().lists.find((l) => l.id === listId);
  if (!list || from === to) return Promise.resolve(null);
  return setListChannels(listId, moveItem(list.channelIds, from, to));
}

export function setListOrder(ids: string[]) {
  const byId = new Map(get().lists.map((l) => [l.id, l]));
  const next = ids.map((id) => byId.get(id)).filter((l): l is ChannelList => !!l);
  return write(next, () => call('PUT /api/lists/order', { body: { ids } }), (lists) => set({ lists }), 'reorder the lists');
}

/** Opens the "Add to list" sheet; a target without a kind is a live channel. */
export function openAddToList(t: { id: string; name: string; kind?: AddToListTarget['kind'] }) {
  set({ addToList: { kind: t.kind ?? 'live', id: t.id, name: t.name } });
}
export function closeAddToList() {
  set({ addToList: null });
}

/* ---------------- Movie and series lists (Watch Later + the user's own) ---------------- */

type Ref = { kind: 'movie' | 'series'; id: string };
let mediaInFlight = 0;
let heldMedia: MediaList[] | null = null;

export function applyMediaListsEvent(lists: MediaList[]) {
  if (mediaInFlight > 0) heldMedia = lists;
  else set({ mediaLists: lists });
}

async function writeMedia<T>(optimistic: MediaList[] | null, req: () => Promise<T>, onOk: (res: T) => void, what: string): Promise<T | null> {
  const before = get().mediaLists;
  if (optimistic) set({ mediaLists: optimistic });
  mediaInFlight++;
  try {
    const res = await req();
    onOk(res);
    return res;
  } catch (e) {
    set({ mediaLists: before });
    toast(`Couldn't ${what}: ${errorMessage(e)}`, 'error');
    return null;
  } finally {
    mediaInFlight--;
    if (mediaInFlight === 0 && heldMedia) {
      set({ mediaLists: heldMedia });
      heldMedia = null;
    }
  }
}

const replaceMedia = (list: MediaList) =>
  set((s) => ({ mediaLists: s.mediaLists.some((l) => l.id === list.id) ? s.mediaLists.map((l) => (l.id === list.id ? list : l)) : [...s.mediaLists, list] }));

export const watchLater = (lists: MediaList[]) => lists.find((l) => l.builtin === 'watch-later');
export const inMediaList = (l: MediaList, kind: Ref['kind'], id: string) => l.items.some((x) => x.kind === kind && x.id === id);

export function createMediaList(name: string, items: Ref[] = []): Promise<MediaList | null> {
  return writeMedia(null, () => call('POST /api/media-lists', { body: { name, items } }), replaceMedia, 'create the list');
}

export function renameMediaList(id: string, name: string) {
  const next = get().mediaLists.map((l) => (l.id === id ? { ...l, name } : l));
  return writeMedia(next, () => call('PATCH /api/media-lists/:id', { params: { id }, body: { name } }), replaceMedia, 'rename the list');
}

export function deleteMediaList(id: string) {
  const next = get().mediaLists.filter((l) => l.id !== id);
  return writeMedia(next, () => call('DELETE /api/media-lists/:id', { params: { id } }), () => {}, 'delete the list');
}

export function setMediaListItems(id: string, items: Ref[]) {
  const list = get().mediaLists.find((l) => l.id === id);
  if (!list) return Promise.resolve(null);
  const added = new Map(list.items.map((x) => [`${x.kind}:${x.id}`, x.addedAt]));
  const now = Date.now();
  const optimistic = { ...list, items: items.map((x) => ({ kind: x.kind, id: x.id, addedAt: added.get(`${x.kind}:${x.id}`) ?? now })) };
  const next = get().mediaLists.map((l) => (l.id === id ? optimistic : l));
  return writeMedia(
    next,
    () => call('PUT /api/media-lists/:id/items', { params: { id }, body: { items: items.map(({ kind, id }) => ({ kind, id })) } }),
    replaceMedia,
    'update the list',
  );
}

/** Adds to the end or takes out. */
export function toggleInMediaList(listId: string, kind: Ref['kind'], id: string, on: boolean) {
  const list = get().mediaLists.find((l) => l.id === listId);
  if (!list || inMediaList(list, kind, id) === on) return Promise.resolve(null);
  const items: Ref[] = list.items.filter((x) => !(x.kind === kind && x.id === id));
  if (on) items.push({ kind, id });
  return setMediaListItems(listId, items);
}

export function toggleWatchLater(kind: Ref['kind'], id: string) {
  const wl = watchLater(get().mediaLists);
  if (!wl) return Promise.resolve(null);
  const on = !inMediaList(wl, kind, id);
  return toggleInMediaList(wl.id, kind, id, on).then((r) => {
    if (r) toast(on ? 'Added to Watch Later' : 'Removed from Watch Later', 'info');
    return r;
  });
}

export function moveMediaItem(listId: string, from: number, to: number) {
  const list = get().mediaLists.find((l) => l.id === listId);
  if (!list || from === to) return Promise.resolve(null);
  return setMediaListItems(listId, moveItem(list.items, from, to));
}

/** The user's own lists in the new order (Watch Later always stays first). */
export function setMediaListOrder(ids: string[]) {
  const byId = new Map(get().mediaLists.map((l) => [l.id, l]));
  const wl = watchLater(get().mediaLists);
  const next = [...(wl ? [wl] : []), ...ids.map((id) => byId.get(id)).filter((l): l is MediaList => !!l && !l.builtin)];
  return writeMedia(next, () => call('PUT /api/media-lists/order', { body: { ids } }), (lists) => set({ mediaLists: lists }), 'reorder the lists');
}
