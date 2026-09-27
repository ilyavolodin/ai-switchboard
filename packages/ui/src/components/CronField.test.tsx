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

  it('explains an invalid expression without calling the API', async () => {
    const { api, user } = renderWithProviders(<Harness initial={{ cron: '', timezone: 'UTC' }} />);
    expect(screen.getByText(/Enter a cron expression/)).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Cron expression' }), '99 * *');
    expect(screen.getByRole('textbox', { name: 'Cron expression' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(api.callsTo('POST /processes/preview/cron')).toHaveLength(0);
  });

  it('changes the timezone', async () => {
    const { user } = renderWithProviders(
      <Harness initial={{ cron: '0 7 * * *', timezone: 'UTC' }} />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Timezone' }), 'Europe/London');
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toHaveValue('Europe/London');
  });
});
