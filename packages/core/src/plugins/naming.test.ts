import { describe, expect, it } from 'vitest';

import {
  isDiscoverablePluginName,
  parsePluginPackageName,
  PLUGIN_NAME_PATTERN,
  pluginKindOf,
} from './naming.js';

describe('plugin naming convention', () => {
  it.each([
    ['ai-switchboard-source-jira', 'source', 'jira'],
    ['@acme/ai-switchboard-destination-n8n', 'destination', 'n8n'],
    ['@ai-switchboard/source-webhook', 'source', 'webhook'],
    ['@ai-switchboard/destination-log', 'destination', 'log'],
    ['@ai-switchboard/source-poll-http', 'source', 'poll-http'],
    ['@ai-switchboard/secrets-env', 'secrets', 'env'],
    ['ai-switchboard-notifier-teams', 'notifier', 'teams'],
  ])('%s is a %s plugin named %s', (pkg, kind, name) => {
    expect(parsePluginPackageName(pkg)).toEqual({ kind, name });
    expect(PLUGIN_NAME_PATTERN.test(pkg)).toBe(true);
  });

  it.each([
    'left-pad',
    '@ai-switchboard/sdk',
    '@ai-switchboard/core',
    '@ai-switchboard/cli',
    'ai-switchboard-sdk',
    'ai-switchboard-widget-x',
    '@acme/switchboard-source-jira',
    'switchboard-source-jira',
    '@acme/source-jira',
    'ai-switchboard-source-',
    '@acme/ai-switchboard-source-jira/extra',
  ])('%s is not discoverable', (pkg) => {
    expect(parsePluginPackageName(pkg)).toBeNull();
    expect(isDiscoverablePluginName(pkg)).toBe(false);
  });

  it('filters by kind and maps secrets to secret providers', () => {
    expect(isDiscoverablePluginName('@acme/ai-switchboard-source-jira', 'source')).toBe(true);
    expect(isDiscoverablePluginName('@acme/ai-switchboard-source-jira', 'destination')).toBe(false);
    expect(pluginKindOf('secrets')).toBe('secret_provider');
    expect(pluginKindOf('source')).toBe('source');
  });
});
