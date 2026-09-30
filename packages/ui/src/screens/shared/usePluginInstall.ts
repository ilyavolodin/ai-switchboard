import type { InspectPluginResponse } from '@ai-switchboard/core/contract';

import { useInspectPlugin, useInstallPlugin } from '../../api/index.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import {
  type InstallVerb,
  installedMessage,
  installPluginPrompt,
  type PluginRequest,
} from './pluginModel.js';

/** Inspect a package's manifest, then install it with a reason. */
export function usePluginInstall(verb: InstallVerb, afterwards: string) {
  const inspect = useInspectPlugin();
  const install = useReasonedMutation(
    useInstallPlugin(),
    (v: PluginRequest) => installPluginPrompt(v, verb, afterwards),
    { successMessage: (added) => installedMessage(added, verb) },
  );
  /** The inspected manifest, only while it is for this exact request. */
  const manifestFor = (request: PluginRequest | null): InspectPluginResponse | null =>
    request &&
    inspect.data &&
    inspect.variables.package === request.package &&
    inspect.variables.range === request.range
      ? inspect.data
      : null;
  /** The inspect error, only while it is for this package. */
  const inspectErrorFor = (pkg: string): Error | null =>
    inspect.isError && inspect.variables.package === pkg ? inspect.error : null;
  return { inspect, install, manifestFor, inspectErrorFor };
}
