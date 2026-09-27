import type { CatalogueEntry } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useParams } from 'react-router';

import { errorMessage } from '../../api/client.js';
import {
  useAbout,
  useCatalogue,
  useInspectPlugin,
  useInstallPlugin,
  usePlugins,
} from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { EmptyState } from '../../components/EmptyState.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { RoutedTabs } from '../../components/RoutedTabs.js';
import { Skeleton } from '../../components/Skeleton.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { AddPluginDialog } from './AddPluginDialog.js';
import { Catalogue } from './Catalogue.js';
import { InstalledPlugins } from './InstalledPlugins.js';

/**
 * Plugins: the Installed tab (versions, types, capabilities, health), the Catalogue of reviewed
 * plugins, and the admin-only Add plugin flow that shows a manifest's capabilities and
 * compatibility before anything is installed.
 */
export function Plugins() {
  const { tab } = useParams();
  const plugins = usePlugins();
  const catalogue = useCatalogue();
  const about = useAbout();
  const inspect = useInspectPlugin();
  const [dialog, setDialog] = useState<{ spec: string; key: number } | null>(null);
  const [open, setOpen] = useState(false);
  const install = useReasonedMutation(
    useInstallPlugin(),
    (v: { package: string; range?: string }) => ({
      title: `Add ${v.package}${v.range ? `@${v.range}` : ''}?`,
      consequence:
        'The package is installed and pinned in plugins.lock.json now; the next restart loads it. Its types can then be used for new instances.',
      confirmLabel: 'Add plugin',
    }),
    { successMessage: 'Added · restart to apply' },
  );

  const startAdd = (spec: string, entry?: CatalogueEntry) => {
    inspect.reset();
    setDialog((d) => ({ spec, key: (d?.key ?? 0) + 1 }));
    setOpen(true);
    if (entry) inspect.mutate({ package: entry.package, range: `^${entry.latestVersion}` });
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
        { to: '/plugins/catalogue', label: 'Catalogue', count: catalogue.data?.length },
      ]}
      extra={
        <span className="t-caption">
          {about.data ? `SDK ${about.data.sdkVersion} · ` : ''}plugins load at start · admins only
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
  } else if (tab === 'catalogue') {
    body = catalogue.isPending ? (
      <Skeleton shape="card" height={320} label="Loading the catalogue" />
    ) : catalogue.isError ? (
      <Banner tone="error" title="The catalogue could not load">
        {errorMessage(catalogue.error)}
      </Banner>
    ) : (
      <Catalogue
        entries={catalogue.data}
        onAdd={(e) => {
          startAdd(`${e.package}@^${e.latestVersion}`, e);
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
