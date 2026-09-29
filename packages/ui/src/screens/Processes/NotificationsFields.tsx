import type { InstanceSummary, ProcessDocument } from '@ai-switchboard/core/contract';
import { NOTIFY_ON } from '@ai-switchboard/core/domain';

import { Checkbox } from '../../components/Checkbox.js';
import { ExpressionEditor } from '../../components/ExpressionEditor.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { AddItemButton } from './AddItemButton.js';
import { newNotification, removeAt, updateAt } from './editorModel.js';
import styles from './ProcessEditor.module.css';
import { RepeatableItem } from './RepeatableItem.js';
import type { SectionProps } from './sectionProps.js';
import { useListKeys } from './useListKeys.js';

type Notification = ProcessDocument['notify'][number];

export function NotificationsFields({
  doc,
  set,
  disabled,
  notifiers,
}: SectionProps & { notifiers: InstanceSummary[] }) {
  const keys = useListKeys(doc.notify.length);
  const put = (i: number, patch: Partial<Notification>) => {
    set((d) => ({ ...d, notify: updateAt(d.notify, i, patch) }));
  };
  return (
    <div className={styles.stack}>
      {doc.notify.length === 0 && (
        <p className="t-caption">
          No notifications. Add one to hear about errors, holds and throttles.
        </p>
      )}
      {doc.notify.map((n, i) => (
        <RepeatableItem
          key={keys.keys[i] ?? i}
          label={`Notification ${i + 1}`}
          overline={`notification ${i + 1}`}
          disabled={disabled}
          onRemove={() => {
            keys.removed(i);
            set((d) => ({ ...d, notify: removeAt(d.notify, i) }));
          }}
        >
          <Field label="Notifier" layout="row">
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                size="sm"
                placeholder="Choose a notifier…"
                value={n.notifierId}
                disabled={disabled}
                options={notifiers.map((x) => ({ value: x.id, label: x.name }))}
                onChange={(e) => {
                  put(i, { notifierId: e.target.value });
                }}
              />
            )}
          </Field>
          <Field label="On" layout="row">
            {() => (
              <div
                className={styles.pills}
                role="group"
                aria-label={`Notification ${i + 1} outcomes`}
              >
                {NOTIFY_ON.map((o) => (
                  <Checkbox
                    key={o}
                    variant="pill"
                    label={o}
                    checked={n.on.includes(o)}
                    disabled={disabled}
                    onChange={(e) => {
                      put(i, {
                        on: e.target.checked
                          ? NOTIFY_ON.filter((x) => x === o || n.on.includes(x))
                          : n.on.filter((x) => x !== o),
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </Field>
          <Field label="Template" help="JSONata over { process, run, events }" layout="row">
            {({ id, describedBy }) => (
              <ExpressionEditor
                id={id}
                describedBy={describedBy}
                label="Notification template"
                value={n.template}
                disabled={disabled}
                completions={{ context: 'template' }}
                insertions={[
                  { label: 'process.name' },
                  { label: 'run.status' },
                  { label: 'run.externalUrl' },
                ]}
                onChange={(template) => {
                  put(i, { template });
                }}
              />
            )}
          </Field>
        </RepeatableItem>
      ))}
      <AddItemButton
        disabled={disabled}
        onClick={() => {
          keys.added();
          set((d) => ({ ...d, notify: [...d.notify, newNotification(notifiers[0]?.id ?? '')] }));
        }}
      >
        Add notification
      </AddItemButton>
    </div>
  );
}
