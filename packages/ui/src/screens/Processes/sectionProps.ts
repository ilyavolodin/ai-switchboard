import type { ProcessDocument } from '@ai-switchboard/core/contract';

export interface SectionProps {
  doc: ProcessDocument;
  baseline: ProcessDocument;
  set: (update: (doc: ProcessDocument) => ProcessDocument) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}
