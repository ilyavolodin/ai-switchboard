import { describe, expect, it } from 'vitest';

import {
  approvePrompt,
  enableProcessPrompt,
  readMetersPrompt,
  rejectPrompt,
  reloadedMessage,
  reloadPrompt,
  resetBreakerPrompt,
  testEventPrompt,
} from './actionPrompts.js';

describe('action prompts', () => {
  it('say the same thing wherever the action is started, named or not', () => {
    expect(resetBreakerPrompt('Autofix').title).toBe('Reset the Autofix breaker?');
    expect(resetBreakerPrompt().title).toBe('Reset the breaker?');
    expect(resetBreakerPrompt('Autofix').consequence).toBe(resetBreakerPrompt().consequence);
    expect(approvePrompt('Merge').title).toBe('Approve the Merge batch?');
    expect(approvePrompt().title).toBe('Approve this batch?');
    expect(rejectPrompt().danger).toBe(true);
    expect(readMetersPrompt('Routines').title).toBe('Read the meters of Routines now?');
    expect(testEventPrompt('GitHub').title).toBe('Send a test event from GitHub?');
  });

  it.each([
    ['source', 'Linear', 'Reload Linear?', 'Source reloaded'],
    ['destination', undefined, 'Reload the destination?', 'Destination reloaded'],
    ['secret provider', 'vault', 'Reload vault?', 'Secret provider reloaded'],
  ] as const)('reload a %s', (noun, name, title, message) => {
    expect(reloadPrompt(noun, name).title).toBe(title);
    expect(reloadedMessage(noun)).toBe(message);
  });

  it('marks disabling a process as destructive and names it on the button', () => {
    expect(enableProcessPrompt('Autofix', false)).toMatchObject({
      title: 'Disable Autofix?',
      confirmLabel: 'Disable Autofix',
      danger: true,
    });
    expect(enableProcessPrompt(undefined, true)).toMatchObject({
      title: 'Enable the process?',
      confirmLabel: 'Enable',
      danger: false,
    });
    expect(enableProcessPrompt('A', true, 'custom').consequence).toBe('custom');
  });
});
