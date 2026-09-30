import type { ProcessDetail, ProcessDocument } from '@ai-switchboard/core/contract';
import { type ReactNode, useReducer, useState } from 'react';
import { useParams } from 'react-router';

import { useDestination, useDestinations, useProcess, useSettings } from '../../api/index.js';
import { useCan } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Card } from '../../components/Card.js';
import { PageHeader } from '../../components/PageHeader.js';
import { Skeleton } from '../../components/Skeleton.js';
import { Time } from '../../components/Time.js';
import { useLeaveGuard } from '../../hooks/useLeaveGuard.js';
import { LeaveGuardDialog } from '../shared/LeaveGuardDialog.js';
import { LoadFailure } from '../shared/LoadFailure.js';
import { unsavedLabel } from '../shared/unsavedLabel.js';
import { BasicsFields } from './BasicsFields.js';
import { BatchingFields } from './BatchingFields.js';
import { BudgetsFields } from './BudgetsFields.js';
import { ConflictBanner } from './ConflictBanner.js';
import { DestinationFields } from './DestinationFields.js';
import { documentChanges } from './diff.js';
import { EditorDiagram } from './EditorDiagram.js';
import { EditorFooter } from './EditorFooter.js';
import { EditorSection } from './EditorSection.js';
import {
  collectErrors,
  type EditorSectionId,
  newProcessDocument,
  SECTION_TITLES,
  SECTIONS,
  sectionForKey,
  sectionSummaries,
  stepProviders,
} from './editorModel.js';
import { GatesFields } from './GatesFields.js';
import { NotificationsFields } from './NotificationsFields.js';
import { draftReducer, initialDraft } from './processDraft.js';
import styles from './ProcessEditor.module.css';
import { SchedulesFields } from './SchedulesFields.js';
import { StepsFields } from './StepsFields.js';
import { TriggersFields } from './TriggersFields.js';
import { useEditorLookups } from './useEditorLookups.js';
import { useOpenSections } from './useOpenSections.js';
import { useSaveProcess } from './useSaveProcess.js';
import { useTestRun } from './useTestRun.js';

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
  const settings = useSettings();
  const lookups = useEditorLookups();

  const [state, dispatch] = useReducer(draftReducer, undefined, () =>
    initialDraft(initial, saved?.version ?? 0),
  );
  const { baseline, draft, baseVersion, clientErrors, serverErrors, conflict, saveError, saving } =
    state;
  const sections = useOpenSections(processId ? ['triggers'] : ['triggers', 'destination']);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initial.triggers.slice(0, 1).map((t) => t.id)),
  );
  const testRun = useTestRun(processId, baseline.name);
  const destination = useDestination(draft.destination.instanceId || undefined);
  const destinationSummary = lookups.destinationSummary(draft.destination.instanceId);

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
  const summaries = sectionSummaries(draft, {
    sourceName: lookups.sourceName,
    notifierName: lookups.notifierName,
    destinationName: destinationSummary?.name,
  });
  const bodies: Record<EditorSectionId, ReactNode> = {
    triggers: (
      <TriggersFields
        {...common}
        sources={lookups.sources}
        expanded={expanded}
        setExpanded={setExpanded}
      />
    ),
    batching: <BatchingFields {...common} />,
    schedules: <SchedulesFields {...common} timezone={settings.data?.timezone ?? 'UTC'} />,
    gates: <GatesFields {...common} />,
    budgets: (
      <BudgetsFields
        {...common}
        destination={destination.data}
        destinationLoading={destination.isLoading}
        processId={processId ?? 'draft'}
      />
    ),
    destination: (
      <DestinationFields
        {...common}
        destinations={lookups.destinations}
        destination={destination.data}
        destinationLoading={destination.isLoading}
        batches={testRun.batches}
        batchId={testRun.batchId}
        onBatchChange={testRun.onBatchChange}
        showAllErrors={Object.keys(clientErrors).length > 0 || serverErrors.length > 0}
      />
    ),
    steps: (
      <StepsFields
        {...common}
        providers={stepProviders(draft, lookups.sourceName, destinationSummary?.name)}
      />
    ),
    notifications: <NotificationsFields {...common} notifiers={lookups.notifiers} />,
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
          sources={lookups.sources}
          destination={destinationSummary}
          processId={processId}
          status={saved?.status}
        />
      </Card>

      <BasicsFields {...common} isNew={!processId} />

      {SECTIONS.map((section) => (
        <EditorSection
          key={section}
          title={SECTION_TITLES[section]}
          summary={summaries[section]}
          open={sections.isOpen(section)}
          onToggle={() => {
            sections.toggle(section);
          }}
          errors={collected.bySection[section] ?? []}
          changed={changedSections.has(section)}
        >
          {bodies[section]}
        </EditorSection>
      ))}

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
        testRun={processId ? testRun : undefined}
      />
      <LeaveGuardDialog blocker={leaveGuard.blocker} summary={unsavedLabel(changes.length)} />
    </div>
  );
}
