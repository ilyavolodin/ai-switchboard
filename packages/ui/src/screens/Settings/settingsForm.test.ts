import { describe, expect, it } from 'vitest';

import { deleteInstancePrompt, enableInstancePrompt, INSTANCE_ROUTES } from './instancesModel.js';
import {
  changedFields,
  checkGeneral,
  checkRetention,
  checkSignIn,
  generalForm,
  parseDomains,
  parsePositiveInt,
  retentionForm,
  signInForm,
} from './settingsForm.js';
import { checkNewUser, grantableRoles, initials } from './users.js';

const general = {
  timezone: 'UTC',
  defaultQuietHours: null,
  meterStalenessMinutes: 15,
  sourceSilenceMinutes: 60,
  systemNotifierId: null,
  requireReasons: true,
};
const retention = {
  eventsDays: 30,
  rawBodiesDays: 7,
  dispatchesDays: 30,
  meterReadingsDays: 90,
  statsHourlyDays: 400,
};

describe('section checks', () => {
  it('saves nothing for an untouched or whitespace-only general form', () => {
    expect(checkGeneral(general, generalForm(general))).toEqual({ patch: {}, errors: {} });
    expect(checkGeneral(general, { ...generalForm(general), timezone: ' UTC ' }).patch).toEqual({});
  });

  it('sends only the changed general fields and names the bad ones', () => {
    const form = { ...generalForm(general), staleness: '20', silence: 'soon' };
    expect(checkGeneral(general, form)).toEqual({
      patch: { meterStalenessMinutes: 20 },
      errors: { silence: 'Enter a whole number of minutes' },
    });
  });

  it('sends every retention limit when one changes', () => {
    const form = { ...retentionForm(retention), rawBodiesDays: '3' };
    expect(checkRetention(retention, form).patch).toEqual({
      retention: { ...retention, rawBodiesDays: 3 },
    });
    expect(checkRetention(retention, { ...form, eventsDays: '0' }).errors).toEqual({
      eventsDays: 'Enter a whole number of days',
    });
  });

  it('turns OIDC off when issuer and client id are cleared, and wants both otherwise', () => {
    const oidc = { issuer: 'https://a.test', clientId: 'c', allowedDomains: ['a.test'] };
    expect(checkSignIn(oidc, { issuer: '', clientId: '', domains: '' }).patch).toEqual({
      oidc: null,
    });
    expect(checkSignIn(oidc, signInForm(oidc))).toEqual({ patch: {}, errors: {} });
    expect(
      checkSignIn(null, { issuer: 'http://a.test', clientId: '', domains: '' }).errors,
    ).toEqual({
      issuer: 'The issuer must be an https:// URL',
      clientId: 'A client id is required with an issuer',
    });
  });
});

describe('settingsForm', () => {
  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['0', null],
    ['-1', null],
    ['1.5', null],
    ['', null],
  ])('parsePositiveInt(%j)', (text, n) => {
    expect(parsePositiveInt(text)).toBe(n);
  });

  it('lists only changed fields', () => {
    expect(changedFields({ a: 1, b: [1] }, { a: 1, b: [2] })).toEqual({ b: [2] });
  });

  it('grants the own role and below', () => {
    expect(grantableRoles('operator')).toEqual(['viewer', 'operator']);
    expect(grantableRoles('admin')).toEqual(['viewer', 'operator', 'admin']);
  });

  it('parses domains and initials', () => {
    expect(parseDomains('Acme.com, b.io  c.dev')).toEqual(['acme.com', 'b.io', 'c.dev']);
    expect(initials('ilya@lola.com')).toBe('IL');
  });

  it('turns saved numbers into editable text', () => {
    expect(retentionForm(retention).rawBodiesDays).toBe('7');
    expect(generalForm(general)).toMatchObject({ staleness: '15', notifier: '' });
  });

  it.each([
    [' Priya@Acme.test ', '', { email: 'priya@acme.test', emailError: null, passwordError: null }],
    ['priya', '', { emailError: 'Enter an email address' }],
    ['priya@acme.test', 'short', { emailError: null }],
  ])('checkNewUser(%j, %j)', (email, password, expected) => {
    expect(checkNewUser(email, password)).toMatchObject(expected);
  });

  it('refuses a weak temporary password', () => {
    expect(checkNewUser('priya@acme.test', 'short').passwordError).not.toBeNull();
  });
});

describe('instancesModel', () => {
  it('words enable, disable and delete per kind', () => {
    expect(enableInstancePrompt('notifiers', 'Slack', false)).toMatchObject({
      title: 'Disable Slack?',
      danger: true,
    });
    expect(enableInstancePrompt('secret-providers', 'vault', true).consequence).toBe(
      'The secret provider is used again from now on.',
    );
    expect(deleteInstancePrompt('secret-providers', 'vault').consequence).toBe(
      'Every secret://vault/… reference stops resolving.',
    );
    expect(INSTANCE_ROUTES.notifiers.canTest).toBe(true);
    expect(INSTANCE_ROUTES['secret-providers'].hasSecrets).toBe(true);
  });
});
