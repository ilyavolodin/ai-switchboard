import type { SourceSummary } from '@ai-switchboard/core/contract';

import { AddItemButton } from './AddItemButton.js';
import { errorsUnder, newTrigger, removeAt, replaceAt } from './editorModel.js';
import type { SectionProps } from './sectionProps.js';
import { TriggerEditor } from './TriggerEditor.js';

/** Which triggers are open is kept by the editor, so it survives collapsing the section. */
export function TriggersFields({
  doc,
  set,
  errors,
  disabled,
  sources,
  expanded,
  setExpanded,
}: SectionProps & {
  sources: SourceSummary[];
  expanded: Set<string>;
  setExpanded: (update: (prev: Set<string>) => Set<string>) => void;
}) {
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      {doc.triggers.length === 0 && (
        <p className="t-caption">
          No triggers: only sweeps start this process. Add a trigger to react to a source’s events.
        </p>
      )}
      {doc.triggers.map((t, i) => (
        <TriggerEditor
          key={t.id}
          trigger={t}
          index={i}
          sources={sources}
          expanded={expanded.has(t.id)}
          disabled={disabled}
          errors={errorsUnder(errors, `/triggers/${i}`)}
          onToggleExpanded={() => {
            toggle(t.id);
          }}
          onChange={(next) => {
            set((d) => ({ ...d, triggers: replaceAt(d.triggers, i, next) }));
          }}
          onRemove={() => {
            set((d) => ({ ...d, triggers: removeAt(d.triggers, i) }));
          }}
        />
      ))}
      <AddItemButton
        disabled={disabled}
        onClick={() => {
          const t = newTrigger(doc.triggers);
          set((d) => ({ ...d, triggers: [...d.triggers, t] }));
          setExpanded((prev) => new Set([...prev, t.id]));
        }}
      >
        Add trigger
      </AddItemButton>
    </>
  );
}
