import type { ReactNode } from 'react';

import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { LeaveGuardDialog } from '../shared/LeaveGuardDialog.js';
import styles from './Settings.module.css';
import type { SettingsSaveState } from './useSettingsSection.js';

export interface SettingsFormCardProps {
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  section: SettingsSaveState;
  /** What the leave prompt calls the unsaved edits, e.g. "Unsaved retention". */
  unsavedSummary: string;
  hint?: ReactNode;
  children: ReactNode;
}

/** An admin-only settings form with Discard and a reasoned Save. */
export function SettingsFormCard({
  title,
  subtitle,
  meta,
  section,
  unsavedSummary,
  hint,
  children,
}: SettingsFormCardProps) {
  return (
    <Card title={title} subtitle={subtitle} meta={meta}>
      <div className={styles.fields}>{children}</div>
      {hint && <p className={styles.hint}>{hint}</p>}
      <div className={styles.footer}>
        {section.dirty && <span className="t-caption">unsaved changes</span>}
        <Button
          variant="ghost"
          disabled={!section.dirty}
          disabledReason="Nothing changed"
          onClick={section.discard}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          requires="admin"
          disabled={!section.dirty || section.invalid}
          disabledReason={section.invalid ? 'Fix the highlighted fields first' : 'Nothing changed'}
          loading={section.saving}
          onClick={section.save}
        >
          Save
        </Button>
      </div>
      <LeaveGuardDialog blocker={section.leaveGuard.blocker} summary={unsavedSummary} />
    </Card>
  );
}
