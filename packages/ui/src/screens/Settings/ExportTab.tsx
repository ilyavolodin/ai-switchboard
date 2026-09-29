import type { ApplyResponse } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useApply, useExportYaml, useSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Field } from '../../components/Field.js';
import { KeyValueList } from '../../components/KeyValueList.js';
import { StatusChip } from '../../components/StatusChip.js';
import { Textarea } from '../../components/Textarea.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import { downloadText } from './download.js';
import { applySummary, CHANGE_TONE } from './exportApply.js';
import styles from './Settings.module.css';

export function ExportTab() {
  return (
    <div className={styles.grid}>
      <ExportCard />
      <ApplyCard />
    </div>
  );
}

function ExportCard() {
  const exportYaml = useExportYaml();
  const settings = useSettings();
  const toast = useToast();
  const schedule = settings.data?.export;
  return (
    <Card title="Export" subtitle="the whole configuration as YAML">
      <p className={styles.hint}>
        Sources, destinations, processes, notifiers and secret providers. Secret references stay as
        secret://… and no value is ever included, so the file is safe to commit.
      </p>
      <div>
        <Button
          variant="outline"
          requires="operator"
          loading={exportYaml.isPending}
          onClick={() => {
            exportYaml.mutate(undefined, {
              onSuccess: (yaml) => {
                downloadText('switchboard.yaml', yaml, 'text/yaml');
              },
              onError: (e) => {
                toast({ tone: 'error', title: 'Export failed', detail: errorMessage(e) });
              },
            });
          }}
        >
          Download YAML
        </Button>
      </div>
      {schedule && (
        <KeyValueList
          label="Scheduled commit"
          data={[
            ['scheduled commit', schedule.schedule ?? 'off'],
            ['repository', schedule.repository ?? '—'],
            ['path', schedule.path ?? '—'],
            ['branch', schedule.branch ?? '—'],
          ]}
        />
      )}
    </Card>
  );
}

function ApplyCard() {
  const isAdmin = useCan('admin');
  const [yaml, setYaml] = useState('');
  // The dry run for exactly this text; editing the text invalidates it.
  const [preview, setPreview] = useState<{ yaml: string; result: ApplyResponse } | null>(null);
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const toast = useToast();
  const apply = useApply();
  const confirmApply = useReasonedMutation(
    apply,
    {
      title: 'Apply this configuration?',
      consequence: preview ? applySummary(preview.result) : undefined,
      confirmLabel: 'Apply configuration',
      danger: true,
    },
    { successMessage: 'Configuration applied' },
  );

  const current = preview?.yaml === yaml ? preview.result : null;
  const changes = current?.changes.filter((c) => c.action !== 'unchanged') ?? [];
  const canApply = current?.errors.length === 0 && changes.length > 0;

  const onPreview = () => {
    setApplied(null);
    apply.mutate(
      { yaml, dryRun: true, reason: 'dry run from Settings · Export' },
      {
        onSuccess: (result) => {
          setPreview({ yaml, result });
        },
        onError: (e) => {
          toast({ tone: 'error', title: 'The dry run failed', detail: errorMessage(e) });
        },
      },
    );
  };

  const onApply = async () => {
    const res = await confirmApply.run({ yaml, dryRun: false });
    if (res) {
      setApplied(res);
      setPreview(null);
    }
  };

  return (
    <Card title="Apply YAML" subtitle="preview the changes, then apply them">
      <Field
        label="Configuration"
        help="Paste a switchboard.yaml. Objects are matched by name; nothing is deleted unless the file says so."
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            mono
            rows={10}
            value={yaml}
            disabled={!isAdmin}
            placeholder={'processes:\n  - name: Autofix\n    …'}
            onChange={(e) => {
              setYaml(e.target.value);
            }}
          />
        )}
      </Field>
      <div className={styles.footer}>
        <Button
          variant="outline"
          requires="admin"
          disabled={yaml.trim() === ''}
          disabledReason="Paste a configuration first"
          loading={apply.isPending && !confirmApply.pending}
          onClick={onPreview}
        >
          Preview changes
        </Button>
        <Button
          variant="primary"
          requires="admin"
          disabled={!canApply}
          disabledReason={
            current == null
              ? 'Preview the changes first'
              : current.errors.length > 0
                ? 'Fix the errors first'
                : 'Nothing to change'
          }
          loading={confirmApply.pending}
          onClick={() => void onApply()}
        >
          Apply
        </Button>
      </div>
      {current && <ApplyResult result={current} />}
      {preview && preview.yaml !== yaml && (
        <p className={styles.hint}>The text changed since the preview; preview it again.</p>
      )}
      {applied && (
        <Banner tone="info" title="Applied">
          {applySummary(applied)}
        </Banner>
      )}
    </Card>
  );
}

function ApplyResult({ result }: { result: ApplyResponse }) {
  const changes = result.changes.filter((c) => c.action !== 'unchanged');
  const unchanged = result.changes.length - changes.length;
  return (
    <div className={styles.fields} aria-label="Dry run">
      {result.errors.length > 0 && (
        <Banner tone="error" title="The configuration has errors">
          <ul>
            {result.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      {changes.length === 0 && result.errors.length === 0 ? (
        <EmptyState title="Nothing would change" compact>
          The running configuration already matches this file.
        </EmptyState>
      ) : (
        <ul className={styles.changes} aria-label="Changes the dry run found">
          {changes.map((c) => (
            <li key={`${c.kind}:${c.name}`}>
              <StatusChip size="sm" tone={CHANGE_TONE[c.action]} label={c.action} />
              <span className="t-caption">{c.kind}</span>
              <span className={styles.itemName}>{c.name}</span>
            </li>
          ))}
        </ul>
      )}
      {unchanged > 0 && <span className="t-caption">{unchanged} unchanged</span>}
    </div>
  );
}
