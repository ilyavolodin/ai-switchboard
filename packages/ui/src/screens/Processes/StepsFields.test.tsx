import type { ProcessDocument } from '@ai-switchboard/core/contract';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../test/render.js';
import { newProcessDocument } from './editorModel.js';
import { StepsFields } from './StepsFields.js';

describe('StepsFields', () => {
  it('applies each edit to the latest document, so two edits before a re-render both land', async () => {
    const start: ProcessDocument = {
      ...newProcessDocument('dst-routines'),
      before: [
        { provider: 'src-linear', action: '', args: '{}' },
        { provider: 'src-linear', action: '', args: '{}' },
      ],
    };
    let doc = start;
    const set = (update: (d: ProcessDocument) => ProcessDocument) => {
      doc = update(doc);
    };
    const { user } = renderWithProviders(
      <StepsFields
        doc={start}
        baseline={start}
        set={set}
        errors={{}}
        providers={[{ id: 'src-linear', name: 'Linear', kind: 'source' }]}
      />,
    );
    const conditions = screen.getAllByRole('textbox', { name: 'Condition' });
    const [first, second] = conditions;
    if (!first || !second) throw new Error('two steps');
    await user.type(first, 'a');
    await user.type(second, 'b');
    expect(doc.before.map((s) => s.when)).toEqual(['a', 'b']);
  });
});
