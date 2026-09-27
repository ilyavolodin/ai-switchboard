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
import { Card } from '../../components/Card.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation, useReasonPrompt } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { LeaveGuardDialog } from '../shared/LeaveGuardDialog.js';
import { useLeaveGuard } from '../shared/useLeaveGuard.js';
import { EXAMPLE_SWEEP } from './batches.js';
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
import { BasicsFields } from './BasicsFields.js';
import { ConflictBanner } from './ConflictBanner.js';
import { EditorFooter } from './EditorFooter.js';
import {
  batchingSummary,
  budgetsSummary,
  checkDocument,
  collectErrors,
  gatesSummary,
  newProcessDocument,
  notificationsSummary,
  type PlacedError,
  placeErrors,
  schedulesSummary,
  type SectionId,
  saveConsequence,
  sectionForKey,
  stepsSummary,
  triggersSummary,
} from './editorModel.js';
import { ExecutorFields } from './ExecutorFields.js';
import { unsavedLabel } from '../shared/unsavedLabel.js';
import styles from './ProcessEditor.module.css';
import { type StepProvider, StepsFields } from './StepsFields.js';
import { TriggersFields } from './TriggersFields.js';

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
        <LoadFailure
          error={process.error}
          noun="process"
          listTo="/processes"
          listLabel="All processes"
        />
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
  const leaveGuard = useLeaveGuard(changes.length > 0);
  const changedSections = new Set(changes.map((c) => sectionForKey(c.path[0])));
  const collected = collectErrors(clientErrors, serverErrors);
  const errors = collected.byPointer;
  const sectionErrors = (section: SectionId) => collected.bySection[section] ?? [];
  const generalErrors = collected.general;

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
  const sectionProps = (section: SectionId) => ({
    open: open.has(section),
    onToggle: () => {
      toggle(section);
    },
    errors: sectionErrors(section),
    changed: changedSections.has(section),
  });

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
      consequence: saveConsequence({
        isNew,
        enabled: draft.enabled,
        changes: changes.map(describeChange),
        baseVersion,
      }),
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
      leaveGuard.allowNextNavigation();
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

      <BasicsFields {...common} isNew={!processId} />

      <EditorSection
        title="Triggers"
        summary={triggersSummary(draft, sourceName)}
        {...sectionProps('triggers')}
      >
        <TriggersFields
          {...common}
          sources={sourceList}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      </EditorSection>

      <EditorSection
        title="Batching"
        summary={batchingSummary(draft.batching)}
        {...sectionProps('batching')}
      >
        <BatchingFields {...common} />
      </EditorSection>

      <EditorSection
        title="Schedules"
        summary={schedulesSummary(draft.schedules)}
        {...sectionProps('schedules')}
      >
        <SchedulesFields {...common} timezone={settings.data?.timezone ?? 'UTC'} />
      </EditorSection>

      <EditorSection title="Gates" summary={gatesSummary(draft.gates)} {...sectionProps('gates')}>
        <GatesFields {...common} />
      </EditorSection>

      <EditorSection
        title="Budgets"
        summary={budgetsSummary(draft.budgets)}
        {...sectionProps('budgets')}
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
        {...sectionProps('executor')}
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

      <EditorSection title="Steps" summary={stepsSummary(draft)} {...sectionProps('steps')}>
        <StepsFields {...common} providers={providers} />
      </EditorSection>

      <EditorSection
        title="Notifications"
        summary={notificationsSummary(draft.notify, notifierName)}
        {...sectionProps('notifications')}
      >
        <NotificationsFields {...common} notifiers={notifiers.data ?? []} />
      </EditorSection>

      {conflict && (
        <ConflictBanner
          baseVersion={baseVersion}
          stored={latest.data}
          onLoadStored={(stored) => {
            setBaseline(stored.document);
            setDraft(stored.document);
            setBaseVersion(stored.version);
            setClientErrors({});
            setServerErrors([]);
            setConflict(false);
          }}
          onKeepMine={(stored) => {
            setBaseVersion(stored.version);
            setConflict(false);
          }}
        />
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

      <EditorFooter
        changes={changes}
        isNew={!processId}
        saving={saving}
        onDiscard={discard}
        onSave={() => {
          void save();
        }}
        testRun={
          processId
            ? {
                batches: batchList,
                batchId,
                onBatchChange: setBatchChoice,
                dryRun,
                onDryRunChange: setDryRun,
                pending: testRun.pending,
                onRun: () => {
                  void testRun.run({ id: processId, dryRun, ...(batchId ? { batchId } : {}) });
                },
              }
            : undefined
        }
      />
      <LeaveGuardDialog blocker={leaveGuard.blocker} summary={unsavedLabel(changes.length)} />
    </div>
  );
}
