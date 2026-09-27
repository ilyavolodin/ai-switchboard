import type { ProcessDetail, ProcessDocument } from '@ai-switchboard/core/contract';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { errorMessage, isApiRequestError } from '../../api/client.js';
import {
  useCreateProcess,
  useExecutor,
  useExecutors,
  useNotifiers,
  useProcess,
  useProcessBatches,
  useRunProcess,
  useSettings,
  useSources,
  useUpdateProcess,
} from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Checkbox } from '../../components/Checkbox.js';
import { Field } from '../../components/Field.js';
import { LinkButton } from '../../components/LinkButton.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Select } from '../../components/Select.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Textarea } from '../../components/Textarea.js';
import { TextField } from '../../components/TextField.js';
import { Time } from '../../components/Time.js';
import { Toggle } from '../../components/Toggle.js';
import { useReasonedMutation, useReasonPrompt } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import { batchOptions, EXAMPLE_SWEEP } from './batches.js';
import { BudgetsFields } from './BudgetsFields.js';
import { describeChange, documentChanges } from './diff.js';
import { EditorDiagram } from './EditorDiagram.js';
import { EditorSection } from './EditorSection.js';
import {
  BatchingFields,
  GatesFields,
  NotificationsFields,
  SchedulesFields,
} from './EditorSections.js';
import {
  batchingSummary,
  budgetsSummary,
  checkDocument,
  gatesSummary,
  newProcessDocument,
  newTrigger,
  notificationsSummary,
  type PlacedError,
  placeErrors,
  schedulesSummary,
  type SectionId,
  sectionForKey,
  stepsSummary,
  triggersSummary,
} from './editorModel.js';
import { ExecutorFields } from './ExecutorFields.js';
import styles from './ProcessEditor.module.css';
import { type StepProvider, StepsFields } from './StepsFields.js';
import { TriggerEditor } from './TriggerEditor.js';

/**
 * The process editor (`/processes/new`, `/processes/:id/edit`): a live diagram on top, the
 * document's sections below in reading order, and a sticky footer with the unsaved changes,
 * Test run and Save (a one-line reason; `expectedVersion` guards against overwriting someone
 * else's save).
 */
export function ProcessEditor() {
  const { id } = useParams();
  const process = useProcess(id);
  const executors = useExecutors();

  if (id) {
    if (process.isPending)
      return <Skeleton shape="card" height={320} label="Loading the process" />;
    if (process.isError) {
      return (
        <Banner
          tone="error"
          title="Could not load the process"
          actions={
            <LinkButton to="/processes" size="sm" variant="outline">
              All processes
            </LinkButton>
          }
        >
          {errorMessage(process.error)}
        </Banner>
      );
    }
    return (
      <EditorForm key={id} processId={id} saved={process.data} initial={process.data.document} />
    );
  }
  if (executors.isPending) return <Skeleton shape="card" height={320} label="Loading executors" />;
  return <EditorForm key="new" initial={newProcessDocument(executors.data?.[0]?.id ?? '')} />;
}

function EditorForm({
  processId,
  saved,
  initial,
}: {
  processId?: string;
  saved?: ProcessDetail;
  initial: ProcessDocument;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const ask = useReasonPrompt();
  const canEdit = useCan('operator');
  const disabled = !canEdit;

  const latest = useProcess(processId);
  const sources = useSources();
  const executors = useExecutors();
  const notifiers = useNotifiers();
  const settings = useSettings();
  const batches = useProcessBatches(processId);
  const create = useCreateProcess();
  const update = useUpdateProcess();

  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [baseVersion, setBaseVersion] = useState(saved?.version ?? 0);
  const [open, setOpen] = useState<Set<SectionId>>(
    () => new Set<SectionId>(processId ? ['triggers'] : ['triggers', 'executor']),
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initial.triggers.slice(0, 1).map((t) => t.id)),
  );
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const [serverErrors, setServerErrors] = useState<PlacedError[]>([]);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [batchChoice, setBatchChoice] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);

  const executor = useExecutor(draft.executor.instanceId || undefined);
  const sourceList = sources.data ?? [];
  const executorList = executors.data ?? [];
  const executorSummary = executorList.find((x) => x.id === draft.executor.instanceId);
  const batchList = batches.data ?? [];
  const batchId = batchChoice ?? batchList[0]?.id ?? EXAMPLE_SWEEP;
  const sourceName = (sid: string) => sourceList.find((s) => s.id === sid)?.name ?? '';
  const notifierName = (nid: string) => notifiers.data?.find((n) => n.id === nid)?.name ?? '';

  const changes = documentChanges(baseline, draft);
  const changedSections = new Set(changes.map((c) => sectionForKey(c.path[0])));
  const errors: Record<string, string> = { ...clientErrors };
  for (const e of serverErrors) if (e.pointer && !errors[e.pointer]) errors[e.pointer] = e.message;
  const sectionErrors = (section: SectionId) => [
    ...Object.entries(clientErrors)
      .filter(([p]) => sectionForKey(p.split('/')[1]) === section)
      .map(([, m]) => m),
    ...serverErrors
      .filter((e) => e.section === section)
      .map((e) => `${e.pointer} ${e.message}`.trim()),
  ];
  const generalErrors = serverErrors.filter((e) => e.section == null);

  const set = (u: (d: ProcessDocument) => ProcessDocument) => {
    setDraft((d) => u(d));
    setSaveError(null);
  };
  const toggle = (s: SectionId) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };
  const openSections = (list: (SectionId | null)[]) => {
    setOpen((prev) => new Set([...prev, ...list.filter((s): s is SectionId => s != null)]));
  };
  const common = { doc: draft, baseline, set, errors, disabled };

  const providers: StepProvider[] = [
    ...[...new Set(draft.triggers.map((t) => t.sourceId).filter(Boolean))].map((sid) => ({
      id: sid,
      name: sourceName(sid) || sid,
      kind: 'source' as const,
    })),
    ...(draft.executor.instanceId
      ? [
          {
            id: draft.executor.instanceId,
            name: executorSummary?.name ?? draft.executor.instanceId,
            kind: 'executor' as const,
          },
        ]
      : []),
  ];

  const testRun = useReasonedMutation(
    useRunProcess(),
    (v) => ({
      title: `Test run ${baseline.name || 'this process'}?`,
      consequence: v.dryRun
        ? 'Invokes the saved version with the chosen batch and a dry-run flag; executors that honour it change nothing.'
        : 'Invokes the saved version for real with the chosen batch: it spends budget and may change things.',
      confirmLabel: 'Start test run',
      danger: !v.dryRun,
    }),
    { successMessage: (r) => `Test run ${r.outcome}${r.runId ? ` · ${r.runId}` : ''}` },
  );

  const save = async () => {
    const problems = checkDocument(draft);
    setClientErrors(problems);
    if (Object.keys(problems).length > 0) {
      openSections(Object.keys(problems).map((p) => sectionForKey(p.split('/')[1])));
      return;
    }
    const isNew = !processId;
    const reason = await ask({
      title: isNew ? `Create ${draft.name}?` : `Save ${draft.name}?`,
      consequence: isNew
        ? `The process is created ${draft.enabled ? 'enabled: its triggers and sweeps start runs right away' : 'disabled; enable it when you are ready'}.`
        : `${changes.length} change${changes.length === 1 ? '' : 's'}: ${changes
            .slice(0, 3)
            .map(describeChange)
            .join(
              '; ',
            )}${changes.length > 3 ? '; …' : ''}. Saving writes version ${baseVersion + 1}.`,
      confirmLabel: isNew ? 'Create process' : 'Save changes',
      placeholder: 'one line — becomes the audit entry',
    });
    if (reason == null) return;
    setSaving(true);
    setServerErrors([]);
    setSaveError(null);
    try {
      const result = processId
        ? await update.mutateAsync({
            id: processId,
            document: draft,
            expectedVersion: baseVersion,
            reason,
          })
        : await create.mutateAsync({ document: draft, reason });
      setBaseline(draft);
      toast({
        tone: 'ok',
        title: isNew
          ? `${result.name} created`
          : `${result.name} saved · version ${result.version}`,
      });
      void navigate(`/processes/${encodeURIComponent(result.id)}`);
    } catch (e) {
      if (isApiRequestError(e) && e.status === 409) {
        setConflict(true);
        void latest.refetch();
      } else if (
        isApiRequestError(e) &&
        (e.status === 422 || e.status === 400) &&
        e.body.details?.length
      ) {
        const placed = placeErrors(e.body.details);
        setServerErrors(placed);
        openSections(placed.map((p) => p.section));
        setSaveError(e.body.message);
      } else {
        setSaveError(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(baseline);
    setClientErrors({});
    setServerErrors([]);
    setSaveError(null);
  };

  const stored = latest.data;
  const saveBlocked = processId != null && changes.length === 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title={draft.name || 'New process'}
        back={
          processId
            ? {
                to: `/processes/${encodeURIComponent(processId)}`,
                label: `Back to ${baseline.name}`,
              }
            : { to: '/processes', label: 'Back to all processes' }
        }
        meta={
          <span className="t-caption">
            {processId ? `editing · version ${baseVersion}` : 'new process · not saved yet'}
          </span>
        }
        actions={
          saved ? (
            <span className="t-caption">
              last saved <Time value={saved.updatedAt} />
            </span>
          ) : undefined
        }
      />

      {!canEdit && (
        <Banner tone="info" title="Read only">
          You have the viewer role: you can look at this process but not change it.
        </Banner>
      )}

      <Card padding="flush" className={styles.diagramCard}>
        <EditorDiagram
          doc={draft}
          sources={sourceList}
          executor={executorSummary}
          processId={processId}
          status={saved?.status}
        />
      </Card>

      <Card className={styles.basics} aria-label="Basics">
        <Field
          label="Name"
          required
          layout="row"
          error={errors['/name']}
          changed={draft.name !== baseline.name}
        >
          {({ id, describedBy, invalid }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              size="sm"
              value={draft.name}
              placeholder="e.g. Autofix"
              disabled={disabled}
              onChange={(e) => {
                const name = e.target.value;
                set((d) => ({ ...d, name }));
              }}
            />
          )}
        </Field>
        <Field
          label="Description"
          layout="row"
          changed={draft.description !== baseline.description}
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              value={draft.description}
              placeholder="What it does and what it never does"
              disabled={disabled}
              onChange={(e) => {
                const description = e.target.value;
                set((d) => ({ ...d, description }));
              }}
            />
          )}
        </Field>
        {!processId && (
          <Field label="Enabled" layout="row" help="off = saved but nothing starts it">
            {({ id }) => (
              <Toggle
                id={id}
                ariaLabel="Enabled after saving"
                checked={draft.enabled}
                requires="operator"
                onChange={(enabled) => {
                  set((d) => ({ ...d, enabled }));
                }}
              />
            )}
          </Field>
        )}
      </Card>

      <EditorSection
        title="Triggers"
        summary={triggersSummary(draft, sourceName)}
        open={open.has('triggers')}
        onToggle={() => {
          toggle('triggers');
        }}
        errors={sectionErrors('triggers')}
        changed={changedSections.has('triggers')}
      >
        {draft.triggers.length === 0 && (
          <p className="t-caption">
            No triggers: only sweeps start this process. Add a trigger to react to a source’s
            events.
          </p>
        )}
        {draft.triggers.map((t, i) => (
          <TriggerEditor
            key={t.id}
            trigger={t}
            index={i}
            sources={sourceList}
            expanded={expanded.has(t.id)}
            disabled={disabled}
            errors={Object.fromEntries(
              Object.entries(errors)
                .filter(([p]) => p.startsWith(`/triggers/${i}/`))
                .map(([p, m]) => [p.slice(`/triggers/${i}`.length), m]),
            )}
            onToggleExpanded={() => {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                return next;
              });
            }}
            onChange={(next) => {
              set((d) => ({ ...d, triggers: d.triggers.map((x, j) => (j === i ? next : x)) }));
            }}
            onRemove={() => {
              set((d) => ({ ...d, triggers: d.triggers.filter((_, j) => j !== i) }));
            }}
          />
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            icon="plus"
            disabled={disabled}
            onClick={() => {
              const t = newTrigger(draft.triggers);
              set((d) => ({ ...d, triggers: [...d.triggers, t] }));
              setExpanded((prev) => new Set([...prev, t.id]));
            }}
          >
            Add trigger
          </Button>
        </div>
      </EditorSection>

      <EditorSection
        title="Batching"
        summary={batchingSummary(draft.batching)}
        open={open.has('batching')}
        onToggle={() => {
          toggle('batching');
        }}
        errors={sectionErrors('batching')}
        changed={changedSections.has('batching')}
      >
        <BatchingFields {...common} />
      </EditorSection>

      <EditorSection
        title="Schedules"
        summary={schedulesSummary(draft.schedules)}
        open={open.has('schedules')}
        onToggle={() => {
          toggle('schedules');
        }}
        errors={sectionErrors('schedules')}
        changed={changedSections.has('schedules')}
      >
        <SchedulesFields {...common} timezone={settings.data?.timezone ?? 'UTC'} />
      </EditorSection>

      <EditorSection
        title="Gates"
        summary={gatesSummary(draft.gates)}
        open={open.has('gates')}
        onToggle={() => {
          toggle('gates');
        }}
        errors={sectionErrors('gates')}
        changed={changedSections.has('gates')}
      >
        <GatesFields {...common} />
      </EditorSection>

      <EditorSection
        title="Budgets"
        summary={budgetsSummary(draft.budgets)}
        open={open.has('budgets')}
        onToggle={() => {
          toggle('budgets');
        }}
        errors={sectionErrors('budgets')}
        changed={changedSections.has('budgets')}
      >
        <BudgetsFields
          {...common}
          executor={executor.data}
          executorLoading={executor.isLoading}
          processId={processId ?? 'draft'}
        />
      </EditorSection>

      <EditorSection
        title="Executor"
        summary={`${executorSummary?.name ?? 'no executor'} · ${draft.trackingDeadlineMinutes} min tracking deadline`}
        open={open.has('executor')}
        onToggle={() => {
          toggle('executor');
        }}
        errors={sectionErrors('executor')}
        changed={changedSections.has('executor')}
      >
        <ExecutorFields
          {...common}
          executors={executorList}
          executor={executor.data}
          executorLoading={executor.isLoading}
          batches={batchList}
          batchId={batchId}
          onBatchChange={setBatchChoice}
          showAllErrors={Object.keys(clientErrors).length > 0 || serverErrors.length > 0}
        />
      </EditorSection>

      <EditorSection
        title="Steps"
        summary={stepsSummary(draft)}
        open={open.has('steps')}
        onToggle={() => {
          toggle('steps');
        }}
        errors={sectionErrors('steps')}
        changed={changedSections.has('steps')}
      >
        <StepsFields {...common} providers={providers} />
      </EditorSection>

      <EditorSection
        title="Notifications"
        summary={notificationsSummary(draft.notify, notifierName)}
        open={open.has('notifications')}
        onToggle={() => {
          toggle('notifications');
        }}
        errors={sectionErrors('notifications')}
        changed={changedSections.has('notifications')}
      >
        <NotificationsFields {...common} notifiers={notifiers.data ?? []} />
      </EditorSection>

      {conflict && (
        <Banner
          tone="error"
          title="Someone else saved this process while you were editing"
          actions={
            stored && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBaseline(stored.document);
                    setDraft(stored.document);
                    setBaseVersion(stored.version);
                    setConflict(false);
                  }}
                >
                  Load version {stored.version} (drop my changes)
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setBaseVersion(stored.version);
                    setConflict(false);
                  }}
                >
                  Keep my changes
                </Button>
              </>
            )
          }
        >
          Nothing was saved. Your changes are based on version {baseVersion}
          {stored && stored.version !== baseVersion
            ? `; the stored version is now ${stored.version}`
            : ''}
          . Load the latest to see what changed, or keep your changes and save again to replace it.
        </Banner>
      )}
      {saveError && !conflict && (
        <Banner tone="error" title="Not saved">
          {saveError}
          {generalErrors.length > 0 && (
            <ul className={styles.errorList}>
              {generalErrors.map((e) => (
                <li key={e.message}>{e.message}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      <div className={styles.footer} role="region" aria-label="Save changes">
        <span className={styles.footerChanges} aria-live="polite">
          {changes.length > 0 ? (
            <>
              <span className={styles.changedDot} aria-hidden="true" />
              <span className={styles.footerCount}>
                {changes.length} unsaved change{changes.length === 1 ? '' : 's'}
              </span>
              <span className={styles.footerFirst} title={changes.map(describeChange).join('\n')}>
                {changes.slice(0, 2).map(describeChange).join(' · ')}
                {changes.length > 2 ? ' · …' : ''}
              </span>
            </>
          ) : (
            <span className="t-caption">{processId ? 'No unsaved changes' : 'Not saved yet'}</span>
          )}
        </span>
        <span className={styles.grow} />
        {processId && (
          <span className={styles.testRun}>
            <Select
              size="sm"
              aria-label="Test batch"
              value={batchId}
              options={batchOptions(batchList)}
              onChange={(e) => {
                setBatchChoice(e.target.value);
              }}
            />
            <Checkbox
              label="dry run"
              checked={dryRun}
              onChange={(e) => {
                setDryRun(e.target.checked);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              icon="play"
              requires="operator"
              loading={testRun.pending}
              onClick={() => {
                void testRun.run({ id: processId, dryRun, ...(batchId ? { batchId } : {}) });
              }}
            >
              Test run
            </Button>
          </span>
        )}
        <Button
          variant="ghost"
          disabled={changes.length === 0}
          disabledReason="No unsaved changes"
          onClick={discard}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          requires="operator"
          loading={saving}
          disabled={saveBlocked}
          disabledReason="No unsaved changes"
          onClick={() => {
            void save();
          }}
        >
          {processId ? 'Save' : 'Create process'}
        </Button>
      </div>
    </div>
  );
}
