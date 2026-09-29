import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-ext-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-ext-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-ext-600.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/poppins/latin-ext-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-ext-500.css';
import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import { applyTheme, getStoredTheme } from './app/theme.js';

applyTheme(getStoredTheme());

async function start(): Promise<void> {
  if (import.meta.env.VITE_MOCK_API === '1') {
    const { createMockApi } = await import('./api/mockApi.js');
    const mock = createMockApi({ delayMs: 150 });
    window.fetch = mock.fetch;
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
