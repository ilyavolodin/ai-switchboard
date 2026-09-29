import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KeyValueList } from './KeyValueList.js';

describe('KeyValueList', () => {
  it('renders scalars, lists and nested values readably', () => {
    render(
      <KeyValueList
        data={{
          binding: null,
          runsToday: 3,
          labels: ['bug', 'p1'],
          checks: [{ check: 'runs_per_hour', pass: true, used: 1, limit: 30 }],
        }}
      />,
    );
    expect(screen.getByText('—')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
    expect(screen.getByText('bug, p1')).toBeVisible();
    expect(
      screen.getByText('{"check":"runs_per_hour","pass":true,"used":1,"limit":30}'),
    ).toBeVisible();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});
