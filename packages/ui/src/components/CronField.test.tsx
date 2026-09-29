import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../test/render.js';
import { CronField, type CronValue } from './CronField.js';

function Harness({ initial }: { initial: CronValue }) {
  const [value, setValue] = useState(initial);
  return <CronField value={value} onChange={setValue} />;
}

describe('CronField', () => {
  it('describes the schedule in plain language and lists the next three runs from the API', async () => {
    const { api } = renderWithProviders(
      <Harness initial={{ cron: '0 7 * * *', timezone: 'America/New_York' }} />,
    );
    expect(screen.getByText('At 07:00')).toBeInTheDocument();
    const next = await screen.findByRole('list', { name: 'Next three runs' });
    expect(next.querySelectorAll('li')).toHaveLength(3);
    const call = api.callsTo('POST /processes/preview/cron')[0];
    expect(call?.body).toEqual({ cron: '0 7 * * *', timezone: 'America/New_York' });
  });

  it('asks for an expression without calling the API while it is empty', () => {
    const { api } = renderWithProviders(<Harness initial={{ cron: '', timezone: 'UTC' }} />);
    expect(screen.getByText(/Enter a cron expression/)).toBeInTheDocument();
    expect(api.callsTo('POST /processes/preview/cron')).toHaveLength(0);
  });

  it('takes validity and the error from the server, not from the describer', async () => {
    renderWithProviders(<Harness initial={{ cron: '0 7 * * * *', timezone: 'UTC' }} />, {
      overrides: {
        'POST /processes/preview/cron': () => ({
          valid: false,
          description: '',
          next: [],
          error: 'Seconds are not supported',
        }),
      },
    });
    expect(await screen.findByText('Seconds are not supported')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Cron expression' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.queryByRole('list', { name: 'Next three runs' })).toBeNull();
  });

  it('accepts what the server accepts and lists its next runs', async () => {
    renderWithProviders(<Harness initial={{ cron: '@daily', timezone: 'UTC' }} />, {
      overrides: {
        'POST /processes/preview/cron': () => ({
          valid: true,
          description: 'Every day at midnight',
          next: ['2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z', '2026-09-30T00:00:00Z'],
        }),
      },
    });
    expect(await screen.findByRole('list', { name: 'Next three runs' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Cron expression' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('changes the timezone', async () => {
    const { user } = renderWithProviders(
      <Harness initial={{ cron: '0 7 * * *', timezone: 'UTC' }} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Timezone' }), 'Europe/London');
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toHaveValue('Europe/London');
  });
});
