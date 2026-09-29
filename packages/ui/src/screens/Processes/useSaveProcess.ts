import type { Dispatch } from 'react';
import { useNavigate } from 'react-router';

import { useCreateProcess, useProcess, useUpdateProcess } from '../../api/index.js';
import { useReasonPrompt } from '../../hooks/reason.js';
import { useToast } from '../../hooks/toast.js';
import { describeChange, documentChanges } from './diff.js';
import {
  checkDocument,
  classifySaveError,
  problemSections,
  type SectionId,
  saveConsequence,
} from './editorModel.js';
import type { DraftAction, DraftState } from './processDraft.js';

interface SaveProcessOptions {
  processId: string | undefined;
  state: DraftState;
  dispatch: Dispatch<DraftAction>;
  openSections: (list: (SectionId | null)[]) => void;
  allowNextNavigation: () => void;
}

/** Checks, asks for the reason, saves, and places a refusal on the fields it names. */
export function useSaveProcess({
  processId,
  state,
  dispatch,
  openSections,
  allowNextNavigation,
}: SaveProcessOptions) {
  const navigate = useNavigate();
  const toast = useToast();
  const ask = useReasonPrompt();
  const latest = useProcess(processId);
  const create = useCreateProcess();
  const update = useUpdateProcess();

  const save = async () => {
    const { draft, baseline, baseVersion } = state;
    const problems = checkDocument(draft);
    dispatch({ type: 'checked', problems });
    if (Object.keys(problems).length > 0) {
      openSections(problemSections(problems));
      return;
    }
    const isNew = !processId;
    const reason = await ask({
      title: isNew ? `Create ${draft.name}?` : `Save ${draft.name}?`,
      consequence: saveConsequence({
        isNew,
        enabled: draft.enabled,
        changes: documentChanges(baseline, draft).map(describeChange),
        baseVersion,
      }),
      confirmLabel: isNew ? 'Create process' : 'Save changes',
      placeholder: 'one line — becomes the audit entry',
    });
    if (reason == null) return;
    dispatch({ type: 'saveStarted' });
    try {
      const result = processId
        ? await update.mutateAsync({
            id: processId,
            document: draft,
            expectedVersion: baseVersion,
            reason,
          })
        : await create.mutateAsync({ document: draft, reason });
      dispatch({ type: 'saved' });
      allowNextNavigation();
      toast({
        tone: 'ok',
        title: isNew
          ? `${result.name} created`
          : `${result.name} saved · version ${result.version}`,
      });
      void navigate(`/processes/${encodeURIComponent(result.id)}`);
    } catch (e) {
      const failure = classifySaveError(e);
      dispatch({ type: 'saveFailed', failure });
      if (failure.kind === 'conflict') void latest.refetch();
      if (failure.kind === 'invalid') openSections(failure.placed.map((p) => p.section));
    }
  };

  return { save, latest: latest.data };
}
