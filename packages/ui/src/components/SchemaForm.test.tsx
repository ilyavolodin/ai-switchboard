import type { JSONSchema } from '@ai-switchboard/core/contract';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { linearSettingsSchema, webhookSettingsSchema } from '../api/fixtures.js';
import { resolveConditionals, validateAgainstSchema, warningFor } from '../lib/schema.js';
import { SchemaForm } from './SchemaForm.js';

let latest: Record<string, unknown> = {};

function Harness({
  schema = linearSettingsSchema,
  initial = {},
  showAllErrors = false,
}: {
  schema?: JSONSchema;
  initial?: Record<string, unknown>;
  showAllErrors?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SchemaForm
      schema={schema}
      value={value}
      showAllErrors={showAllErrors}
      secretProviders={['env', 'file']}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

describe('SchemaForm', () => {
  it('renders x-group groups as fieldsets in x-order', () => {
    render(<Harness />);
    const workspace = screen.getByRole('group', { name: 'Workspace' });
    const credentials = screen.getByRole('group', { name: 'Credentials' });
    expect(within(workspace).getByLabelText(/Team key/)).toBeInTheDocument();
    expect(within(credentials).getByRole('textbox', { name: /^API key/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Advanced' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Team key/)).toHaveAccessibleDescription(/The Linear team/);
  });

  it('marks required fields', () => {
    render(<Harness />);
    expect(screen.getByText('Team key').closest('label')).toHaveTextContent('(required)');
  });

  it('stores secrets as secret:// references and never renders a value', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ webhookSecret: 'hunter2-plaintext' }} />);
    expect(screen.queryByDisplayValue('hunter2-plaintext')).toBeNull();
    expect(screen.queryByText(/hunter2/)).toBeNull();
    expect(screen.getByText(/A value is stored here directly \(hidden\)/)).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: /^API key/ });
    await user.type(name, 'LINEAR_API_KEY');
    expect(latest.apiKey).toBe('secret://env/LINEAR_API_KEY');

    await user.selectOptions(screen.getByRole('combobox', { name: 'API key provider' }), 'file');
    expect(latest.apiKey).toBe('secret://file/LINEAR_API_KEY');
  });

  it('shows validation messages from the schema', async () => {
    const user = userEvent.setup();
    render(<Harness showAllErrors />);
    expect(screen.getAllByText('Required').length).toBeGreaterThanOrEqual(3);
    const team = screen.getByLabelText(/Team key/);
    await user.type(team, 'L');
    expect(screen.getByText('Use at least 2 characters')).toBeInTheDocument();
    await user.type(team, 'OL');
    expect(screen.queryByText('Use at least 2 characters')).toBeNull();
    const poll = screen.getByLabelText(/Backfill poll interval/);
    await user.type(poll, '5');
    expect(screen.getByText('Must be at least 60')).toBeInTheDocument();
  });

  it('only shows messages for touched fields until asked for all', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText('Required')).toBeNull();
    await user.type(screen.getByLabelText(/Team key/), 'X');
    expect(screen.getByText('Use at least 2 characters')).toBeInTheDocument();
    expect(screen.queryByText('Required')).toBeNull();
  });

  it('handles enums, booleans, arrays of strings, arrays of objects and nested objects', async () => {
    const user = userEvent.setup();
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        site: { title: 'Site', enum: ['datadoghq.com', 'datadoghq.eu'] },
        verbose: { type: 'boolean', title: 'Verbose' },
        tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
        stages: { type: 'array', title: 'Stages', items: { enum: ['matched', 'batched'] } },
        repos: {
          type: 'array',
          title: 'Repositories',
          items: {
            type: 'object',
            title: 'Repository',
            properties: { name: { type: 'string', title: 'Name' } },
          },
        },
        retry: {
          type: 'object',
          title: 'Retry',
          properties: { attempts: { type: 'integer', title: 'Attempts', default: 3 } },
        },
      },
    };
    render(<Harness schema={schema} />);

    await user.selectOptions(screen.getByLabelText('Site'), 'datadoghq.eu');
    expect(latest.site).toBe('datadoghq.eu');

    await user.click(screen.getByRole('switch', { name: 'Verbose' }));
    expect(latest.verbose).toBe(true);

    const tags = screen.getByRole('group', { name: 'Tags' });
    await user.click(within(tags).getByRole('button', { name: 'Add' }));
    await user.type(within(tags).getByRole('textbox', { name: 'Tags 1' }), 'prod');
    expect(latest.tags).toEqual(['prod']);

    await user.click(screen.getByRole('checkbox', { name: 'batched' }));
    expect(latest.stages).toEqual(['batched']);

    await user.click(screen.getByRole('button', { name: 'Add repository' }));
    const repo = screen.getByRole('group', { name: 'Repository 1' });
    await user.type(within(repo).getByLabelText('Name'), 'acme/app');
    expect(latest.repos).toEqual([{ name: 'acme/app' }]);

    const retry = screen.getByRole('group', { name: 'Retry' });
    expect(within(retry).getByText('default')).toHaveTextContent('default 3');
    await user.type(within(retry).getByLabelText('Attempts'), '5');
    expect(latest.retry).toEqual({ attempts: 5 });
  });

  it('honours if/then: fields of branches that do not apply are hidden and not required', async () => {
    const user = userEvent.setup();
    render(<Harness schema={webhookSettingsSchema} initial={{ verification: 'hmac' }} />);
    expect(screen.getByText('Secret').closest('label')).toHaveTextContent('(required)');
    expect(screen.getByLabelText(/Signature header/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Shared-secret header/)).toBeNull();

    await user.selectOptions(screen.getByLabelText(/^Verification/), 'none');
    expect(screen.queryByText('Secret')).toBeNull();
    expect(screen.queryByLabelText(/Signature header/)).toBeNull();
    expect(screen.queryByLabelText(/Shared-secret header/)).toBeNull();
    expect(screen.getByLabelText(/^Mapping/)).toBeInTheDocument();
    expect(validateAgainstSchema(webhookSettingsSchema, { ...latest, mapping: 'x' })).toEqual({});
  });

  it('honours if/then/else and dependentRequired for required-ness', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        auth: { type: 'string', enum: ['token', 'app'] },
        token: { type: 'string' },
        appId: { type: 'string' },
        proxy: { type: 'string' },
        proxyUser: { type: 'string' },
      },
      allOf: [
        {
          if: { properties: { auth: { const: 'token' } }, required: ['auth'] },
          then: { required: ['token'] },
          else: { required: ['appId'] },
        },
      ],
      dependentRequired: { proxy: ['proxyUser'] },
    };
    expect(resolveConditionals(schema, { auth: 'token' })).toEqual({
      required: ['token'],
      hidden: new Set(['appId']),
    });
    expect(resolveConditionals(schema, { auth: 'app', proxy: 'p' })).toEqual({
      required: ['appId', 'proxyUser'],
      hidden: new Set(['token']),
    });
  });

  it('shows an x-warning under the field while its value matches', async () => {
    const user = userEvent.setup();
    render(<Harness schema={webhookSettingsSchema} initial={{ verification: 'hmac' }} />);
    expect(screen.queryByRole('note')).toBeNull();
    await user.selectOptions(screen.getByLabelText(/^Verification/), 'none');
    expect(screen.getByRole('note')).toHaveTextContent(
      'Anyone who knows the URL can send events — evaluation only.',
    );
    expect(screen.getByLabelText(/^Verification/)).toHaveAccessibleDescription(
      /Anyone who knows the URL/,
    );
    const verification = webhookSettingsSchema.properties as Record<string, JSONSchema>;
    expect(warningFor(verification.verification ?? {}, 'hmac')).toBeNull();
  });

  it('exposes the same validation for gating a save', () => {
    expect(validateAgainstSchema(linearSettingsSchema, {})).toMatchObject({
      '/team': ['Required'],
      '/apiKey': ['Required'],
    });
    expect(
      validateAgainstSchema(linearSettingsSchema, {
        team: 'LOL',
        apiKey: 'secret://env/A',
        webhookSecret: 'secret://env/B',
      }),
    ).toEqual({});
  });

  it('stores an array of integers as numbers', async () => {
    const user = userEvent.setup();
    const schema: JSONSchema = {
      type: 'object',
      properties: { ports: { type: 'array', items: { type: 'integer' }, title: 'Ports' } },
    };
    render(<Harness schema={schema} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByRole('textbox', { name: 'Ports 1' }), '8080');
    expect(latest).toEqual({ ports: [8080] });
    expect(validateAgainstSchema(schema, latest)).toEqual({});
  });

  it('shows the default of an unset boolean', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: { verifyTls: { type: 'boolean', default: true, title: 'Verify TLS' } },
    };
    render(<Harness schema={schema} />);
    expect(screen.getByRole('switch', { name: 'Verify TLS' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('reads a nullable anyOf as its non-null type', async () => {
    const user = userEvent.setup();
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        timeoutSeconds: {
          anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
          title: 'Timeout seconds',
        },
      },
    };
    render(<Harness schema={schema} />);
    const input = screen.getByRole('spinbutton', { name: 'Timeout seconds' });
    await user.type(input, '30');
    expect(latest).toEqual({ timeoutSeconds: 30 });
  });
});
