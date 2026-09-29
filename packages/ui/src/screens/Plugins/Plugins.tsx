import type { PluginSearchResult } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import { useAbout, usePlugins } from '../../api/index.js';
import { Button } from '../../components/Button.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { QueryError } from '../../components/QueryError.js';
import { AddPluginDialog } from './AddPluginDialog.js';
import { InstalledPlugins } from './InstalledPlugins.js';
import { NpmSearch } from '../shared/NpmSearch.js';
import { UnknownTab } from '../shared/UnknownTab.js';
import { usePluginInstall } from '../shared/usePluginInstall.js';

/**
 * An installed plugin is loaded at once and a removed one unloaded at once; only upgrading a loaded
 * one waits for a restart.
 */
export function Plugins() {
  const { tab } = useParams();
  const plugins = usePlugins();
  const about = useAbout();
  const { inspect, install } = usePluginInstall(
    'Add',
    'Its types can be used for new instances straight away.',
  );
  const [dialog, setDialog] = useState<{ spec: string; key: number } | null>(null);
  const [open, setOpen] = useState(false);

  const startAdd = (spec: string, result?: PluginSearchResult) => {
    inspect.reset();
    setDialog((d) => ({ spec, key: (d?.key ?? 0) + 1 }));
    setOpen(true);
    if (result) inspect.mutate({ package: result.package, range: `^${result.version}` });
  };

  const header = (
    <PageHeader
      title="Plugins"
      description="Everything is a plugin except the wiring."
      actions={
        <Button
          variant="primary"
          icon="plus"
          requires="admin"
          onClick={() => {
            startAdd('');
          }}
        >
          Add plugin
        </Button>
      }
    />
  );

  const tabs = (
    <RoutedTabs
      label="Plugin sections"
      items={[
        { to: '/plugins', label: 'Installed', end: true, count: plugins.data?.length },
        { to: '/plugins/browse', label: 'Browse npm' },
      ]}
      extra={
        <span className="t-caption">
          {about.data ? `SDK ${about.data.sdkVersion} · ` : ''}installs load at once · admins only
        </span>
      }
    />
  );

  let body;
  if (tab === undefined) {
    body = plugins.isPending ? (
      <Skeleton shape="card" height={320} label="Loading plugins" />
    ) : plugins.isError ? (
      <QueryError query={plugins} title="Plugins could not load" />
    ) : (
      <InstalledPlugins plugins={plugins.data} />
    );
  } else if (tab === 'browse' || tab === 'catalogue') {
    body = (
      <NpmSearch
        onInstall={(r) => {
          startAdd(`${r.package}@^${r.version}`, r);
        }}
      />
    );
  } else {
    body = <UnknownTab to="/plugins" label="Installed" />;
  }

  return (
    <>
      {header}
      {tabs}
      {body}
      {dialog && (
        <AddPluginDialog
          key={dialog.key}
          open={open}
          initialSpec={dialog.spec}
          inspect={inspect}
          onClose={() => {
            setOpen(false);
          }}
          onConfirm={async (request) => {
            const added = await install.run(request);
            if (!added) return false;
            setDialog(null);
            return true;
          }}
        />
      )}
    </>
  );
}
