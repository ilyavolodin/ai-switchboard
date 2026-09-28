import type { PluginSearchResult } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { useAbout, useInspectPlugin, useInstallPlugin, usePlugins } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { AddPluginDialog } from './AddPluginDialog.js';
import { InstalledPlugins } from './InstalledPlugins.js';
import { NpmSearch } from './NpmSearch.js';

/**
 * Plugins: the Installed tab (versions, types, capabilities, health), Browse npm (packages that
 * follow the naming convention, with the reviewed badge), and the admin-only Add plugin flow that
 * shows a manifest's capabilities and compatibility before anything is installed. An installed
 * plugin is loaded at once and a removed one unloaded at once; only upgrading a loaded one waits
 * for a restart.
 */
export function Plugins() {
  const { tab } = useParams();
  const plugins = usePlugins();
  const about = useAbout();
  const inspect = useInspectPlugin();
  const [dialog, setDialog] = useState<{ spec: string; key: number } | null>(null);
  const [open, setOpen] = useState(false);
  const install = useReasonedMutation(
    useInstallPlugin(),
    (v: { package: string; range?: string }) => ({
      title: `Add ${v.package}${v.range ? `@${v.range}` : ''}?`,
      consequence:
        'The package is installed, pinned in plugins.lock.json and loaded now; every replica installs it within a minute. Its types can be used for new instances straight away.',
      confirmLabel: 'Add plugin',
    }),
    {
      successMessage: (added) =>
        added.pendingRestart ? 'Added · restart to apply' : 'Added · ready to use',
    },
  );

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
      <Banner tone="error" title="Plugins could not load">
        {errorMessage(plugins.error)}
      </Banner>
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
    body = (
      <EmptyState
        title="No such tab"
        compact
        actions={
          <LinkButton to="/plugins" variant="outline">
            Installed
          </LinkButton>
        }
      />
    );
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
            setOpen(false);
            const added = await install.run(request);
            if (!added) {
              setOpen(true);
              return false;
            }
            setDialog(null);
            return true;
          }}
        />
      )}
    </>
  );
}
