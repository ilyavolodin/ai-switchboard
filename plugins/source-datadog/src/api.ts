import { asArray, type HttpClient, type HttpResponse, type JsonObject } from '@ai-switchboard/sdk';

import { apiHost, type DatadogSettings } from './settings.js';

export class DatadogApiError extends Error {
  override readonly name = 'DatadogApiError';
}

export function errorText(body: JsonObject | undefined, status: number): string {
  const errors = asArray(body?.errors).filter((e): e is string => typeof e === 'string');
  return errors.length > 0 ? errors.join('; ') : `HTTP ${status}`;
}

export interface DatadogApi {
  monitor(id: string): Promise<HttpResponse>;
  validate(): Promise<HttpResponse>;
}

export function createApi(http: HttpClient, s: DatadogSettings): DatadogApi {
  const base = `https://${apiHost(s.site)}`;
  const headers = (): Record<string, string> => ({
    accept: 'application/json',
    'dd-api-key': s.apiKey ?? '',
    ...(s.appKey !== undefined && s.appKey !== '' ? { 'dd-application-key': s.appKey } : {}),
  });
  return {
    monitor: (id) => http.get(`${base}/api/v1/monitor/${id}`, { headers: headers() }),
    validate: () => http.get(`${base}/api/v1/validate`, { headers: headers() }),
  };
}
