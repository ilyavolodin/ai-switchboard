export { MAX_INVOKE_TIMEOUT_SECONDS } from '@ai-switchboard/sdk/constants';

export const DEFAULT_PORT = 8080;
/** Relative to the working directory. */
export const DEFAULT_HOME = '.switchboard';

/** When neither the instance nor the destination type sets `invokeTimeoutSeconds`. */
export const DEFAULT_INVOKE_TIMEOUT_SECONDS = 300;
export const MIN_INVOKE_TIMEOUT_SECONDS = 1;

/** How often a destination's meters are read when `caps.meterPollSeconds` is unset. */
export const DEFAULT_METER_POLL_SECONDS = 300;
export const MIN_METER_POLL_SECONDS = 30;

/** `HH:MM` on a 24-hour clock, as quiet hours are written. */
export const HHMM_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
