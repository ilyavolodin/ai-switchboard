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
  return { inspect, install };
}
