import { describe, expect, it } from 'vitest';

import { closeEmails, isEmail, levenshtein } from './emails.js';

const emails = [
  'admin@switchboard.local',
  'carol@acme.test',
  'dave@acme.test',
  'ops@example.org',
  'ilya@lola.com',
];

describe('closeEmails', () => {
  it.each([
    ['a typo in the address', 'admin@switchbaord.local', ['admin@switchboard.local']],
    ['the local part alone', 'admin', ['admin@switchboard.local']],
    ['the right person at another domain', 'carol@acme.com', ['carol@acme.test']],
    ['anyone at the same domain', 'erin@acme.test', ['carol@acme.test', 'dave@acme.test']],
    ['case and spaces', '  ILYA@Lola.com ', ['ilya@lola.com']],
  ])('matches %s', (_label, wanted, expected) => {
    expect(closeEmails(wanted, emails)).toEqual(expected);
  });

  it('suggests nothing for an unrelated address', () => {
    expect(closeEmails('zed@nowhere.example', emails)).toEqual([]);
  });

  it('caps the suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) => `user${i}@acme.test`);
    expect(closeEmails('someone@acme.test', many, 3)).toHaveLength(3);
  });
});

describe('levenshtein', () => {
  it.each([
    ['', '', 0],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
    ['local', 'lokal', 1],
  ])('%s → %s is %d', (a, b, d) => {
    expect(levenshtein(a, b)).toBe(d);
  });
});

describe('isEmail', () => {
  it.each([
    ['a@b.c', true],
    ['a@b', true],
    ['a b@c.d', false],
    ['@b.c', false],
    ['a@', false],
  ])('%s → %s', (email, valid) => {
    expect(isEmail(email)).toBe(valid);
  });
});
