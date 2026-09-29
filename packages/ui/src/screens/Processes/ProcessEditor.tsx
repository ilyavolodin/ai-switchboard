import type { ProcessDetail, ProcessDocument } from '@ai-switchboard/core/contract';
import { useReducer, useState } from 'react';
import { useParams } from 'react-router';

import {
  useDestination,
  useDestinations,
  useNotifiers,
  useProcess,
  useProcessBatches,
  useRunProcess,
  useSettings,
  useSources,
} from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { LeaveGuardDialog } from '../shared/LeaveGuardDialog.js';
import { useLeaveGuard } from '../shared/useLeaveGuard.js';
import { EXAMPLE_SWEEP } from './batches.js';
import { BudgetsFields } from './BudgetsFields.js';
import { documentChanges } from './diff.js';
import { EditorDiagram } from './EditorDiagram.js';
import { EditorSection } from './EditorSection.js';
import { BasicsFields } from './BasicsFields.js';
import { BatchingFields } from './BatchingFields.js';
import { ConflictBanner } from './ConflictBanner.js';
import { EditorFooter } from './EditorFooter.js';
import { GatesFields } from './GatesFields.js';
import { NotificationsFields } from './NotificationsFields.js';
import {
  batchingSummary,
  budgetsSummary,
  collectErrors,
  gatesSummary,
  newProcessDocument,
  notificationsSummary,
  schedulesSummary,
  type SectionId,
  sectionForKey,
  stepProviders,
  stepsSummary,
  triggersSummary,
} from './editorModel.js';
import { DestinationFields } from './DestinationFields.js';
import { unsavedLabel } from '../shared/unsavedLabel.js';
import styles from './ProcessEditor.module.css';
import { SchedulesFields } from './SchedulesFields.js';
import { draftReducer, initialDraft } from './processDraft.js';
import { StepsFields } from './StepsFields.js';
import { TriggersFields } from './TriggersFields.js';
import { useOpenSections } from './useOpenSections.js';
import { useSaveProcess } from './useSaveProcess.js';

export function ProcessEditor() {
  const { id } = useParams();
  const process = useProcess(id);
  const destinations = useDestinations();

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
  if (destinations.isPending)
    return <Skeleton shape="card" height={320} label="Loading destinations" />;
  return <EditorForm key="new" initial={newProcessDocument(destinations.data?.[0]?.id ?? '')} />;
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
  const canEdit = useCan('operator');
  const disabled = !canEdit;

  const sources = useSources();
  const destinations = useDestinations();
  const notifiers = useNotifiers();
  const settings = useSettings();
  const batches = useProcessBatches(processId);

  const [state, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft(initial, saved?.version ?? 0),
  );
  const { baseline, draft, baseVersion, clientErrors, serverErrors, conflict, saveError, saving } =
    state;
  const sections = useOpenSections(processId ? ['triggers'] : ['triggers', 'destination']);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initial.triggers.slice(0, 1).map((t) => t.id)),
  );
  const [batchChoice, setBatchChoice] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(true);

  const destination = useDestination(draft.destination.instanceId || undefined);
  const sourceList = sources.data ?? [];
  const destinationList = destinations.data ?? [];
  const destinationSummary = destinationList.find((x) => x.id === draft.destination.instanceId);
  const batchList = batches.data ?? [];
  const batchId = batchChoice ?? batchList[0]?.id ?? EXAMPLE_SWEEP;
  const sourceName = (sid: string) => sourceList.find((s) => s.id === sid)?.name ?? '';
  const notifierName = (nid: string) => notifiers.data?.find((n) => n.id === nid)?.name ?? '';

  const changes = documentChanges(baseline, draft);
  const leaveGuard = useLeaveGuard(changes.length > 0);
  const changedSections = new Set(changes.map((c) => sectionForKey(c.path[0])));
  const collected = collectErrors(clientErrors, serverErrors);
  const { save, latest } = useSaveProcess({
    processId,
    state,
    dispatch,
    openSections: sections.openAll,
    allowNextNavigation: leaveGuard.allowNextNavigation,
  });

  const set = (update: (d: ProcessDocument) => ProcessDocument) => {
    dispatch({ type: 'edit', update });
  };
  const common = { doc: draft, baseline, set, errors: collected.byPointer, disabled };
  const sectionProps = (section: SectionId) => ({
    open: sections.isOpen(section),
    onToggle: () => {
      sections.toggle(section);
    },
    errors: collected.bySection[section] ?? [],
    changed: changedSections.has(section),
  });

  const testRun = useReasonedMutation(
    useRunProcess(),
    (v) => ({
      title: `Test run ${baseline.name || 'this process'}?`,
      consequence: v.dryRun
        ? 'Invokes the saved version with the chosen batch and a dry-run flag; destinations that honour it change nothing.'
        : 'Invokes the saved version for real with the chosen batch: it spends budget and may change things.',
      confirmLabel: 'Start test run',
      danger: !v.dryRun,
    }),
    { successMessage: (r) => `Test run ${r.outcome}${r.runId ? ` · ${r.runId}` : ''}` },
  );

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
          destination={destinationSummary}
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
          destination={destination.data}
          destinationLoading={destination.isLoading}
          processId={processId ?? 'draft'}
        />
      </EditorSection>

      <EditorSection
        title="Destination"
        summary={`${destinationSummary?.name ?? 'no destination'} · ${draft.trackingDeadlineMinutes} min tracking deadline`}
        {...sectionProps('destination')}
      >
        <DestinationFields
          {...common}
          destinations={destinationList}
          destination={destination.data}
          destinationLoading={destination.isLoading}
          batches={batchList}
          batchId={batchId}
          onBatchChange={setBatchChoice}
          showAllErrors={Object.keys(clientErrors).length > 0 || serverErrors.length > 0}
        />
      </EditorSection>

      <EditorSection title="Steps" summary={stepsSummary(draft)} {...sectionProps('steps')}>
        <StepsFields
          {...common}
          providers={stepProviders(draft, sourceName, destinationSummary?.name)}
        />
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
          stored={latest}
          onLoadStored={(stored) => {
            dispatch({ type: 'loadStored', document: stored.document, version: stored.version });
          }}
          onKeepMine={(stored) => {
            dispatch({ type: 'keepMine', version: stored.version });
          }}
        />
      )}
      {saveError && !conflict && (
        <Banner tone="error" title="Not saved">
          {saveError}
          {collected.general.length > 0 && (
            <ul className={styles.errorList}>
              {collected.general.map((e) => (
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
        onDiscard={() => {
          dispatch({ type: 'discard' });
        }}
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
