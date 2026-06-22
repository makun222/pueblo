import React, { useState, useEffect, useCallback } from 'react';
import type { McpServerConfig } from '../../shared/ipc-contract';

interface McpServerEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

interface ConnectionStatus {
  serverId: string;
  connected: boolean;
  error?: string;
}

export interface McpManagerProps {
  onClose: () => void;
}

export const McpManager: React.FC<McpManagerProps> = ({ onClose }) => {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [connStatus, setConnStatus] = useState<Map<string, boolean>>(new Map());
  const [editingServer, setEditingServer] = useState<McpServerEntry | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [connectingIndex, setConnectingIndex] = useState<number | null>(null);

  // Form state for add/edit
  const [formName, setFormName] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formArgs, setFormArgs] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formEnv, setFormEnv] = useState('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [infoMessages, setInfoMessages] = useState<Record<string, string>>({});
  const [showExample, setShowExample] = useState(false);

  const loadServers = useCallback(async () => {
    try {
      const list = await window.electronAPI.mcpListServers();
      setServers(list);
      // Refresh connection status
      const statusMap = new Map<string, boolean>();
      for (const srv of list) {
        try {
          const status = await window.electronAPI.mcpTestConnection(srv);
          statusMap.set(srv.id, status.success);
        } catch {
          statusMap.set(srv.id, false);
        }
      }
      setConnStatus(statusMap);
    } catch (err) {
      console.error('Failed to load MCP servers:', err);
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const resetForm = useCallback(() => {
    setFormName('');
    setFormCommand('');
    setFormArgs('');
    setFormDescription('');
    setFormEnv('');
    setEditingServer(null);
    setIsAdding(false);
    setTestResult(null);
  }, []);

  const openAddForm = useCallback(() => {
    resetForm();
    setIsAdding(true);
  }, [resetForm]);

  const openEditForm = useCallback((server: McpServerEntry) => {
    setEditingServer(server);
    setFormName(server.name);
    setFormCommand(server.command);
    setFormArgs(server.args.join(' '));
    setFormDescription(server.description || '');
    setFormEnv(server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : '');
    setIsAdding(false);
  }, []);

  // === Validation helpers (req-mcp-2 §2.1) ===
  const validateName = (name: string): string | null => {
    if (!name.trim()) return 'Server name is required';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name.trim()))
      return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores';
    return null;
  };

  const validateCommand = (cmd: string): string | null => {
    if (!cmd.trim()) return 'Command is required';
    if (/\s/.test(cmd.trim())) return 'Command must not contain spaces';
    return null;
  };

  const cleanArgs = (args: string): string => {
    const cleaned = args.replace(/\/+$/, '');
    if (cleaned !== args) {
      setInfoMessages(prev => ({ ...prev, args: 'Trailing slash(es) removed' }));
    } else {
      setInfoMessages(prev => {
        const { args: _, ...rest } = prev;
        return rest;
      });
    }
    return cleaned;
  };

  const validateEnv = (env: string): string | null => {
    if (!env.trim()) return null;
    const lines = env.split('\n');
    const invalid: number[] = [];
    lines.forEach((line, i) => {
      if (line.trim() !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=.+$/.test(line.trim())) {
        invalid.push(i + 1);
      }
    });
    if (invalid.length > 0) {
      return `Invalid format on line(s): ${invalid.join(', ')}. Use KEY=VALUE (one per line)`;
    }
    return null;
  };

  const handleSave = useCallback(async () => {
    if (!formName.trim() || !formCommand.trim()) {
      setTestResult('Name and command are required.');
      return;
    }

    const entry: McpServerEntry = {
      id: editingServer?.id ?? formName.trim().toLowerCase().replace(/\s+/g, '-'),
      name: formName.trim(),
      command: formCommand.trim(),
      args: formArgs.trim() ? formArgs.trim().split(/\s+/) : [],
      description: formDescription.trim() || undefined,
      env: formEnv.trim()
        ? Object.fromEntries(
            formEnv
              .trim()
              .split('\n')
              .filter((l) => l.includes('='))
              .map((l) => {
                const idx = l.indexOf('=');
                return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
              }),
          )
        : undefined,
    };

    try {
      await window.electronAPI.mcpUpdateServer({ ...entry, enabled: true });
      resetForm();
      await loadServers();
    } catch (err) {
      setTestResult(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [formName, formCommand, formArgs, formDescription, formEnv, editingServer, resetForm, loadServers]);

  const handleDelete = useCallback(
    async (serverId: string) => {
      try {
        await window.electronAPI.mcpRemoveServer(serverId);
        await loadServers();
      } catch (err) {
        console.error('Failed to delete server:', err);
      }
    },
    [loadServers],
  );

  const handleTestConnection = useCallback(
    async (idx: number) => {
      if (connectingIndex !== null) return;
      const server = servers[idx];
      if (!server) return;
      setConnectingIndex(idx);
      setTestResult(null);
      try {
        const serverConfig: McpServerConfig = { ...server, enabled: true };
        const result = await window.electronAPI.mcpTestConnection(serverConfig);
        const toolCount = result.toolCount ?? 0;
        setTestResult(`✅ Connection successful — ${toolCount} tool(s) discovered`);
        setConnStatus((prev) => {
          const next = new Map(prev);
          next.set(server.id, result.success);
          return next;
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setTestResult(`❌ Connection failed — ${message}`);
      } finally {
        setConnectingIndex(null);
      }
    },
    [servers, connectingIndex],
  );

  return (
    <div className="mcp-manager-overlay" onClick={onClose}>
      <div className="mcp-manager-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-manager-header">
          <h2>MCP Server Manager</h2>
          <button className="mcp-manager-close" onClick={onClose}>×</button>
        </div>

        <div className="mcp-manager-body">
          {/* Server list */}
          <div className="mcp-manager-section">
            <div className="mcp-manager-section-header">
              <h3>Configured Servers</h3>
              <button className="mcp-manager-add-btn" onClick={openAddForm}>
                + Add Server
              </button>
              <button className="mcp-manager-btn mcp-manager-btn-secondary" onClick={loadServers}>
                ↻ Refresh
              </button>
            </div>

            {servers.length === 0 && !isAdding && (
              <p className="mcp-manager-empty">No MCP servers configured. Click "Add Server" to get started.</p>
            )}

            <ul className="mcp-manager-server-list">
              {servers.map((server, idx) => (
                <li key={server.id} className="mcp-manager-server-item">
                  <div className="mcp-manager-server-info">
                    <span className="mcp-manager-server-name">{server.name}</span>
                    <span className="mcp-manager-server-command">{server.command}</span>
                    <span
                      className={`mcp-manager-server-status ${connStatus.get(server.id) ? 'connected' : 'disconnected'}`}
                    >
                      {connStatus.get(server.id) ? '\u25CF Connected' : '\u25CB Disconnected'}
                    </span>
                  </div>
                  <div className="mcp-manager-server-actions">
                    <button
                      className="mcp-manager-btn mcp-manager-btn-test"
                      onClick={() => handleTestConnection(idx)}
                      disabled={connectingIndex === idx}
                    >
                      {connectingIndex === idx ? '⏳ Connecting...' : 'Test'}
                    </button>
                    <button className="mcp-manager-btn mcp-manager-btn-edit" onClick={() => openEditForm(server)}>
                      Edit
                    </button>
                    <button className="mcp-manager-btn mcp-manager-btn-delete" onClick={() => handleDelete(server.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Example configuration panel */}
          <div className="mcp-manager-section mcp-manager-example-section">
            <button
              className="mcp-manager-example-toggle"
              onClick={() => setShowExample(!showExample)}
              type="button"
            >
              {showExample ? '\u25BE ' : '\u25B8 '}Example Configuration
            </button>
            {showExample && (
              <div className="mcp-manager-example-content">
                <pre>{`# MCP Server Configuration Examples

Name: my-filesystem-server
Command: npx
Arguments: -y @modelcontextprotocol/server-filesystem /path/to/allowed/dir
Description: Access local filesystem through MCP

Name: my-python-server
Command: python
Arguments: -m my_mcp_server
Environment:
API_KEY=sk-abc123xyz
DEBUG=true`}</pre>
              </div>
            )}
          </div>

          {/* Add / Edit form */}
          {(isAdding || editingServer) && (
            <div className="mcp-manager-section mcp-manager-form-section">
              <h3>{editingServer ? 'Edit Server' : 'Add Server'}</h3>

              <label className="mcp-manager-field">
                <span>Name *</span>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => {
                    setFormName(e.target.value);
                    setValidationErrors(prev => { const { name: _, ...rest } = prev; return rest; });
                  }}
                  onBlur={(e) => {
                    const err = validateName(e.target.value);
                    setValidationErrors(prev => err ? { ...prev, name: err } : prev);
                  }}
                  placeholder="e.g., filesystem-server"
                  className={validationErrors.name ? 'mcp-manager-input-error' : ''}
                />
                {validationErrors.name && <span className="mcp-manager-error-msg">{validationErrors.name}</span>}
              </label>

              <label className="mcp-manager-field">
                <span>Command *</span>
                <input
                  type="text"
                  value={formCommand}
                  onChange={(e) => {
                    setFormCommand(e.target.value);
                    setValidationErrors(prev => { const { command: _, ...rest } = prev; return rest; });
                  }}
                  onBlur={(e) => {
                    const err = validateCommand(e.target.value);
                    setValidationErrors(prev => err ? { ...prev, command: err } : prev);
                  }}
                  placeholder="e.g., npx"
                  className={validationErrors.command ? 'mcp-manager-input-error' : ''}
                />
                {validationErrors.command && <span className="mcp-manager-error-msg">{validationErrors.command}</span>}
              </label>

              <label className="mcp-manager-field">
                <span>Arguments</span>
                <input
                  type="text"
                  value={formArgs}
                  onChange={(e) => {
                    const cleaned = cleanArgs(e.target.value);
                    setFormArgs(cleaned);
                  }}
                  placeholder="e.g., -y @modelcontextprotocol/server-filesystem ."
                />
                {infoMessages.args && <span className="mcp-manager-info-msg">{infoMessages.args}</span>}
              </label>

              <label className="mcp-manager-field">
                <span>Description</span>
                <input
                  type="text"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </label>

              <label className="mcp-manager-field">
                <span>Environment Variables</span>
                <textarea
                  value={formEnv}
                  onChange={(e) => {
                    setFormEnv(e.target.value);
                    setValidationErrors(prev => { const { env: _, ...rest } = prev; return rest; });
                  }}
                  onBlur={(e) => {
                    const err = validateEnv(e.target.value);
                    setValidationErrors(prev => err ? { ...prev, env: err } : prev);
                  }}
                  placeholder="KEY=VALUE (one per line)"
                  rows={3}
                  className={validationErrors.env ? 'mcp-manager-input-error' : ''}
                />
                {validationErrors.env && <span className="mcp-manager-error-msg">{validationErrors.env}</span>}
              </label>

              {testResult && (() => {
                const isSuccess = testResult.includes('✅');
                const isTimeout = testResult.includes('timed out');
                const resultClass = isSuccess ? 'success' : isTimeout ? 'warning' : 'error';
                return (
                  <div className={`mcp-manager-test-result ${resultClass}`}>
                    {testResult}
                  </div>
                );
              })()}

              <div className="mcp-manager-form-actions">
                <button className="mcp-manager-btn mcp-manager-btn-save" onClick={handleSave}>
                  {editingServer ? 'Save Changes' : 'Add Server'}
                </button>
                <button className="mcp-manager-btn mcp-manager-btn-cancel" onClick={resetForm}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
