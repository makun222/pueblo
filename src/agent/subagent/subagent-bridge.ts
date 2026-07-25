/**
 * Sub-agent bridge — integrates SubAgentService with the main agent's ToolService.
 *
 * Phase 2b: This module wires up sub-agent tools (spawn_subagent / check_subagent)
 * so they are available to the main CamelAgent's LLM loop via ToolService.
 */
import { ToolService } from '../../tools/tool-service.js';
import type { SubAgentToolDeps } from './subagent-types.js';
import { SubAgentService } from './subagent-service.js';
import { createSubAgentTool } from './subagent-tool.js';

/**
 * Creates a SubAgentService and registers its tools (spawn_subagent, check_subagent)
 * as custom tool providers on the given ToolService.
 *
 * Call this once per agent session with the current runtime execution deps.
 */
export function registerSubAgentTools(
  toolService: ToolService,
  deps: SubAgentToolDeps,
): void {
  const subAgentService = new SubAgentService(deps);
  const provider = createSubAgentTool(subAgentService);
  toolService.registerCustomToolProvider(provider);
}
