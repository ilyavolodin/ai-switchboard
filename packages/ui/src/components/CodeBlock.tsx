import { useState } from 'react';

import styles from './CodeBlock.module.css';
import { IconButton } from './IconButton.js';

export interface CodeBlockProps {
  value: unknown;
  maxHeight?: number;
  copyable?: boolean;
  label?: string;
}

export function CodeBlock({ value, maxHeight = 320, copyable = false, label }: CodeBlockProps) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <pre className={styles.block} style={{ maxHeight }} aria-label={label}>
      {copyable && (
        <span className={styles.copy}>
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label={copied ? 'Copied' : 'Copy'}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
              });
            }}
          />
        </span>
      )}
      {text}
    </pre>
  );
}
