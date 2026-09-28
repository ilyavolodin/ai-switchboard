import type { PluginSummary } from '@ai-switchboard/core/contract';

import { useRemovePlugin } from '../../api/index.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Table, type TableColumn } from '../../components/Table.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import styles from './Plugins.module.css';
import { kindLabel, networkText, secretsText } from './pluginModel.js';

function instanceCount(p: PluginSummary): number {
  return p.types.reduce((s, t) => s + t.instanceCount, 0);
}

/**
 * The Installed tab: every plugin with its version, origin, contributed types (with instance
 * counts), declared capabilities, and health (status, errors and invalid events the core
 * attributed to it in 24 h, pending restart). Admins can remove plugins they installed.
 */
export function InstalledPlugins({ plugins }: { plugins: PluginSummary[] }) {
  const remove = useReasonedMutation(
    useRemovePlugin(),
    (v: { pluginName: string }) => {
      const p = plugins.find((x) => x.name === v.pluginName);
      const n = p ? instanceCount(p) : 0;
      return {
        title: `Remove ${v.pluginName}?`,
        consequence: `It is unloaded now, and every replica removes its copy within a minute.${
          n > 0
            ? ` Its ${n} instance${n === 1 ? '' : 's'} stay configured but are held until it is back.`
            : ''
        }`,
        confirmLabel: 'Remove plugin',
        danger: true,
      };
    },
    { successMessage: 'Removed · replicas follow within a minute' },
  );

  const failing = plugins.filter((p) => p.status !== 'loaded');
  const pending = plugins.filter((p) => p.pendingRestart);

  const columns: TableColumn<PluginSummary>[] = [
    {
      key: 'package',
      header: 'Package',
      cell: (p) => {
        const n = instanceCount(p);
        return (
          <span className={styles.pkg}>
            <span className={styles.pkgName}>{p.name}</span>
            <span className={styles.sub}>
              {p.displayName} · {n} instance{n === 1 ? '' : 's'}
            </span>
          </span>
        );
      },
    },
    { key: 'version', header: 'Version', mono: true, cell: (p) => p.version },
    {
      key: 'origin',
      header: 'Origin',
      cell: (p) => (p.origin === 'baked' ? 'baked into the image' : 'installed'),
    },
    {
      key: 'types',
      header: 'Contributes',
      cell: (p) => (
        <span className={styles.types}>
          {p.types.map((t) => (
            <span key={`${t.kind}:${t.typeId}`}>
              {kindLabel(t.kind)} · <span className="mono">{t.typeId}</span>{' '}
              <span className={styles.sub}>({t.instanceCount})</span>
            </span>
          ))}
        </span>
      ),
    },
    {
      key: 'capabilities',
      header: 'Capabilities · network · secrets',
      cell: (p) => (
        <span className={styles.types}>
          <span className="mono">{networkText(p.capabilities)}</span>
          <span className="mono">{secretsText(p.capabilities)}</span>
        </span>
      ),
    },
    {
      key: 'health',
      header: 'Health',
      cell: (p) => (
        <span className={styles.health}>
          <StatusChip
            size="sm"
            tone={p.statusLabel.tone}
            label={p.statusLabel.label}
            title={p.statusMessage ?? undefined}
          />
          {(p.errorCount > 0 || p.invalidEventCount > 0) && (
            <span className={styles.sub}>
              {p.errorCount} error{p.errorCount === 1 ? '' : 's'} · {p.invalidEventCount} invalid
              event{p.invalidEventCount === 1 ? '' : 's'} · 24 h
            </span>
          )}
          {p.pendingRestart && <StatusChip size="sm" tone="warn" label="pending restart" />}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      align: 'right',
      cell: (p) =>
        p.origin === 'installed' ? (
          <Button
            size="sm"
            variant="danger-outline"
            requires="admin"
            aria-label={`Remove ${p.name}`}
            onClick={() => void remove.run({ pluginName: p.name })}
          >
            Remove
          </Button>
        ) : null,
    },
  ];

  if (plugins.length === 0) {
    return (
      <EmptyState title="No plugins installed">
        Everything but the wiring is a plugin. Add one from the Catalogue tab.
      </EmptyState>
    );
  }

  return (
    <>
      {failing.map((p) => (
        <Banner key={p.name} tone="error" title={`${p.name} ${p.statusLabel.label}`}>
          {p.statusMessage ?? 'It did not load at start.'} Its instances and the processes they feed
          are held until it is updated or removed.
        </Banner>
      ))}
      {pending.length > 0 && (
        <Banner tone="info" title="A restart applies pending changes">
          {pending.map((p) => p.name).join(', ')} change{pending.length === 1 ? 's' : ''} on the
          next restart.
        </Banner>
      )}
      <Card padding="flush">
        <Table
          caption="Installed plugins"
          columns={columns}
          rows={plugins}
          rowKey={(p) => p.name}
        />
      </Card>
      <p className={styles.foot}>
        Health counts exceptions and invalid events the core attributed to each plugin in the last
        24 h. Capabilities are declared in the manifest and enforced for the SDK&apos;s HttpClient
        and secret resolution.
      </p>
    </>
  );
}
