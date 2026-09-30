import { useCronPreview } from '../hooks/useCronPreview.js';
import { type CronFieldProps, CronFieldView } from './CronFieldView.js';

export type { CronFieldProps, CronValue } from './CronFieldView.js';

/** A `<CronFieldView>` checked against the server as the person types. */
export function CronField(props: CronFieldProps) {
  return <CronFieldView {...props} answer={useCronPreview(props.value)} />;
}
