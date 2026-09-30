import type { ReactNode } from 'react';

import { RoutedTabs } from '../../components/RoutedTabs.js';
import { UnknownTab } from './UnknownTab.js';

export interface DetailTab {
  /** The URL segment after the base; `undefined` for the first (overview) tab. */
  segment?: string;
  label: string;
  count?: number;
  render: () => ReactNode;
}

/** Tabs as URL segments under `base`, and the body of the one `tab` names. */
export function DetailTabs({
  label,
  base,
  tab,
  tabs,
}: {
  label: string;
  base: string;
  tab: string | undefined;
  tabs: DetailTab[];
}) {
  const current = tabs.find((t) => t.segment === tab);
  return (
    <>
      <RoutedTabs
        label={label}
        items={tabs.map((t) => ({
          to: t.segment ? `${base}/${t.segment}` : base,
          label: t.label,
          ...(t.segment ? {} : { end: true }),
          ...(t.count !== undefined ? { count: t.count } : {}),
        }))}
      />
      {current ? current.render() : <UnknownTab to={base} />}
    </>
  );
}
