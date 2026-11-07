import { normalizeTabOrder, type TabId } from '@anycast/shared';
import { IconHome, IconLists, IconLive, IconMovie, IconSearch, IconSeries, IconSettings, IconStar } from '../components/Icons';

export const TABS: Record<TabId | 'settings', { label: string; short: string; path: string; key: string; Icon: typeof IconLive }> = {
  home: { label: 'Home', short: 'Home', path: '/home', key: 'H', Icon: IconHome },
  search: { label: 'Search', short: 'Search', path: '/search', key: '/', Icon: IconSearch },
  favorites: { label: 'Favorites', short: 'Favorites', path: '/favorites', key: 'F', Icon: IconStar },
  lists: { label: 'Lists', short: 'Lists', path: '/lists', key: 'T', Icon: IconLists },
  live: { label: 'Live TV', short: 'Live', path: '/live', key: 'L', Icon: IconLive },
  movies: { label: 'Movies', short: 'Movies', path: '/movies', key: 'M', Icon: IconMovie },
  series: { label: 'Series', short: 'Series', path: '/series', key: 'S', Icon: IconSeries },
  settings: { label: 'Settings', short: 'Settings', path: '/settings', key: ',', Icon: IconSettings },
};

export function visibleTabs(order: TabId[], hidden: TabId[]): TabId[] {
  const vis = normalizeTabOrder(order).filter((t) => !hidden.includes(t));
  return vis.length ? vis : ['live'];
}
