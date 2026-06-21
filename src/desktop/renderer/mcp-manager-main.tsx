import React from 'react';
import { createRoot } from 'react-dom/client';
import { McpManager } from './mcp-manager';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <McpManager onClose={() => window.close()} />
    </React.StrictMode>,
  );
}
