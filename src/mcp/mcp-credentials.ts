// ---------------------------------------------------------------------------
// MCP Credentials — Encrypted storage of API keys using Electron safeStorage
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

// Electron safeStorage may not be available in all contexts (tests, non-Electron)
let safeStorageModule: typeof import('electron').safeStorage | null = null;
try {
  safeStorageModule = require('electron').safeStorage;
} catch {
  // Not in Electron context
}

/** Path to the encrypted credentials file */
function getCredentialsPath(): string {
  // Fallback same as config dir
  const configDir = (() => {
    try {
      return require('electron').app.getPath('userData');
    } catch {
      return join(process.cwd(), '.pueblo');
    }
  })();
  return join(configDir, 'mcp-credentials.enc');
}

// ─── Encryption Helpers ──────────────────────────────────────────────────

/** Check if encryption is available */
export function isEncryptionAvailable(): boolean {
  return safeStorageModule !== null && safeStorageModule.isEncryptionAvailable();
}

/** Encrypt a string value */
async function encrypt(text: string): Promise<Buffer> {
  if (!safeStorageModule) {
    throw new Error('Electron safeStorage not available');
  }
  return safeStorageModule.encryptString(text);
}

/** Decrypt a buffer to string */
async function decrypt(data: Buffer): Promise<string> {
  if (!safeStorageModule) {
    throw new Error('Electron safeStorage not available');
  }
  return safeStorageModule.decryptString(data);
}

// ─── Credentials Store ───────────────────────────────────────────────────

interface CredentialsStore {
  [serverId: string]: {
    /** Encrypted API key as base64 string for JSON serialization */
    encryptedKey: string;
  };
}

/** Load the credentials store */
async function loadCredentialsStore(): Promise<CredentialsStore> {
  const credPath = getCredentialsPath();
  try {
    const data = await readFile(credPath, 'utf-8');
    return JSON.parse(data) as CredentialsStore;
  } catch {
    return {};
  }
}

/** Save the credentials store */
async function saveCredentialsStore(store: CredentialsStore): Promise<void> {
  const credPath = getCredentialsPath();
  const credDir = dirname(credPath);
  if (!existsSync(credDir)) {
    await mkdir(credDir, { recursive: true });
  }
  await writeFile(credPath, JSON.stringify(store, null, 2), 'utf-8');
}

// ─── Public API ──────────────────────────────────────────────────────────

/** Store an API key for a given server */
export async function setApiKey(serverId: string, apiKey: string): Promise<void> {
  if (!safeStorageModule) {
    throw new Error('Cannot store API key: Electron safeStorage not available');
  }

  const encrypted = await encrypt(apiKey);
  const store = await loadCredentialsStore();
  store[serverId] = {
    encryptedKey: encrypted.toString('base64'),
  };
  await saveCredentialsStore(store);
}

/** Retrieve an API key for a given server */
export async function getApiKey(serverId: string): Promise<string | null> {
  if (!safeStorageModule) {
    return null;
  }

  const store = await loadCredentialsStore();
  const entry = store[serverId];
  if (!entry) return null;

  try {
    const buffer = Buffer.from(entry.encryptedKey, 'base64');
    return await decrypt(buffer);
  } catch {
    return null;
  }
}

/** Delete an API key for a given server */
export async function deleteApiKey(serverId: string): Promise<void> {
  const store = await loadCredentialsStore();
  if (store[serverId]) {
    delete store[serverId];
    await saveCredentialsStore(store);
  }
}

/** List server IDs that have stored keys */
export async function listApiKeyServers(): Promise<string[]> {
  const store = await loadCredentialsStore();
  return Object.keys(store);
}
