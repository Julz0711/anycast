import type { TabId } from '@anycast/shared';
import { IconLive, IconMovie, IconSearch, IconSeries, IconSettings } from '../components/Icons';

export const TABS: Record<TabId | 'settings', { label: string; short: string; path: string; key: string; Icon: typeof IconLive }> = {
  live: { label: 'Live TV', short: 'Live', path: '/live', key: 'L', Icon: IconLive },
  movies: { label: 'Movies', short: 'Movies', path: '/movies', key: 'M', Icon: IconMovie },
  series: { label: 'Series', short: 'Series', path: '/series', key: 'S', Icon: IconSeries },
  search: { label: 'Search', short: 'Search', path: '/search', key: '/', Icon: IconSearch },
  settings: { label: 'Settings', short: 'Settings', path: '/settings', key: ',', Icon: IconSettings },
};

export function visibleTabs(order: TabId[], hidden: TabId[]): TabId[] {
  const all: TabId[] = ['live', 'movies', 'series', 'search'];
  const ordered = [...order.filter((t) => all.includes(t)), ...all.filter((t) => !order.includes(t))];
  const vis = ordered.filter((t) => !hidden.includes(t));
  return vis.length ? vis : ['live'];
}
