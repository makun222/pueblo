// ---------------------------------------------------------------------------
// MCP Server Registry — Built-in well-known MCP server definitions
// ---------------------------------------------------------------------------

import type { McpServerConfig } from './mcp-types';

/**
 * A well-known MCP server template users can discover and add.
 */
export interface RegistryEntry {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly template: McpServerConfig;
}

/**
 * Built-in registry of well-known MCP servers.
 * Users can discover these and add them with a single click.
 */
const registryEntries: RegistryEntry[] = [
  {
    name: 'Filesystem',
    description: 'Read, write, and search files on the local filesystem',
    category: 'core',
    template: {
      id: 'filesystem',
      name: 'filesystem',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      source: 'builtin',
    },
  },
  {
    name: 'GitHub',
    description: 'Query and manage GitHub repositories, issues, and PRs',
    category: 'devtools',
    template: {
      id: 'github',
      name: 'github',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
      source: 'builtin',
    },
  },
  {
    name: 'PostgreSQL',
    description: 'Query and explore PostgreSQL databases',
    category: 'databases',
    template: {
      id: 'postgresql',
      name: 'postgresql',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: {},
      source: 'builtin',
    },
  },
  {
    name: 'SQLite',
    description: 'Query and explore SQLite databases',
    category: 'databases',
    template: {
      id: 'sqlite',
      name: 'sqlite',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '.'],
      source: 'builtin',
    },
  },
  {
    name: 'Puppeteer',
    description: 'Browser automation and web scraping via Puppeteer',
    category: 'automation',
    template: {
      id: 'puppeteer',
      name: 'puppeteer',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      source: 'builtin',
    },
  },
  {
    name: 'Memory',
    description: 'Persistent knowledge graph memory for the assistant',
    category: 'ai',
    template: {
      id: 'memory',
      name: 'memory',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      source: 'builtin',
    },
  },
];

/**
 * Returns all registry entries.
 */
export function getRegistryEntries(): RegistryEntry[] {
  return registryEntries;
}

/**
 * Filters registry entries by category.
 */
export function getRegistryByCategory(category: string): RegistryEntry[] {
  return registryEntries.filter((e) => e.category === category);
}

/**
 * Returns all available categories.
 */
export function getRegistryCategories(): string[] {
  const cats = new Set(registryEntries.map((e) => e.category));
  return Array.from(cats);
}
