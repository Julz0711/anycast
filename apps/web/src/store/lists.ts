/**
 * Channel lists (LB-3): optimistic changes, the server's answer wins. While our own writes are in
 * flight, 'lists' events (which may describe an older state) are held back, so a quick series of
 * drags never flickers back to an earlier order.
 */
import type { ChannelList } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { moveItem, toggleId } from '../lib/reorder';
import { useApp } from './app';
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

export function openAddToList(ch: { id: string; name: string }) {
  set({ addToList: { id: ch.id, name: ch.name } });
}
export function closeAddToList() {
  set({ addToList: null });
}
