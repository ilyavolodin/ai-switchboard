import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CoalesceDemo } from './CoalesceDemo.js';

describe('CoalesceDemo', () => {
  it('uses the pipeline rule: an event arriving exactly when the debounce ends opens a new batch', () => {
    render(<CoalesceDemo batching={{ debounceSeconds: 25, maxSize: 20, maxAgeSeconds: 600 }} />);
    expect(screen.getByRole('img', { name: /^10 events become 6 runs/ })).toBeInTheDocument();
  });

  it('closes on max size', () => {
    render(<CoalesceDemo batching={{ debounceSeconds: 600, maxSize: 5, maxAgeSeconds: 0 }} />);
    expect(
      screen.getByRole('img', {
        name: '10 events become 2 runs: 5 closed by max size, 5 closed by max size',
      }),
    ).toBeInTheDocument();
  });
});
