import { Button } from '../../components/Button.js';
import { Checkbox } from '../../components/Checkbox.js';
import { Select } from '../../components/Select.js';
import { unsavedLabel } from '../shared/unsavedLabel.js';
import { batchOptions } from './batches.js';
import { type Change, describeChange } from './diff.js';
import styles from './ProcessEditor.module.css';
import type { TestRunControls } from './useTestRun.js';

export interface EditorFooterProps {
  changes: Change[];
  isNew: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  testRun?: TestRunControls;
}

export function EditorFooter({
  changes,
  isNew,
  saving,
  onDiscard,
  onSave,
  testRun,
}: EditorFooterProps) {
  return (
    <div className={styles.footer} role="region" aria-label="Save changes">
      <span className={styles.footerChanges} aria-live="polite">
        {changes.length > 0 ? (
          <>
            <span className={styles.changedDot} aria-hidden="true" />
            <span className={styles.footerCount}>{unsavedLabel(changes.length)}</span>
            <span className={styles.footerFirst} title={changes.map(describeChange).join('\n')}>
              {changes.slice(0, 2).map(describeChange).join(' · ')}
              {changes.length > 2 ? ' · …' : ''}
            </span>
          </>
        ) : (
          <span className="t-caption">{isNew ? 'Not saved yet' : 'No unsaved changes'}</span>
        )}
      </span>
      <span className={styles.grow} />
      {testRun && (
        <span className={styles.testRun}>
          <Select
            size="sm"
            aria-label="Test batch"
            value={testRun.batchId}
            options={batchOptions(testRun.batches)}
            onChange={(e) => {
              testRun.onBatchChange(e.target.value);
            }}
          />
          <Checkbox
            label="dry run"
            checked={testRun.dryRun}
            onChange={(e) => {
              testRun.onDryRunChange(e.target.checked);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            icon="play"
            requires="operator"
            loading={testRun.pending}
            onClick={testRun.onRun}
          >
            Test run
          </Button>
        </span>
      )}
      <Button
        variant="ghost"
        disabled={changes.length === 0}
        disabledReason="No unsaved changes"
        onClick={onDiscard}
      >
        Discard
      </Button>
      <Button
        variant="primary"
        requires="operator"
        loading={saving}
        disabled={!isNew && changes.length === 0}
        disabledReason="No unsaved changes"
        onClick={onSave}
      >
        {isNew ? 'Create process' : 'Save'}
      </Button>
    </div>
  );
}
