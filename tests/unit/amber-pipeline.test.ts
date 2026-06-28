import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parsePipelineYamlFile } from '../../src/amber/pipeline.js';
import { parseAgentMdFile } from '../../src/amber/parsers/agent-template-parser.js';
import { parseSkillMdFile } from '../../src/amber/parsers/skill-parser.js';
import { discoverSkills } from '../../src/amber/template-resolver.js';
import {
  schedulePhases,
  collectUpstreamArtifacts,
} from '../../src/amber/pipeline.js';
import { createAmberContext, buildPhaseAgentInput, resolveAmberContext } from '../../src/amber/amber-context.js';
import type { AmberContext, Phase } from '../../src/amber/amber-types.js';

const fixturesRoot = path.resolve(__dirname, '..', 'fixtures');

// ─── Fixture paths ────────────────────────────────────────────────────────────
const pipelinePath = path.join(fixturesRoot, 'pipeline.sample.yaml');
const agentPath = path.join(fixturesRoot, 'agent.sample.md');
const skillsDir = path.join(fixturesRoot, 'skills');

// ─── 1. Pipeline YAML parsing ────────────────────────────────────────────────

describe('Pipeline YAML parsing', () => {
  const pipeline = parsePipelineYamlFile(pipelinePath);

  it('parses version and name', () => {
    expect(pipeline.version).toBe('1.0');
    expect(pipeline.name).toBe('SamplePipeline');
  });

  it('has exactly 3 phases', () => {
    expect(pipeline.phases).toHaveLength(3);
  });

  it('phase-a has no dependencies', () => {
    const a = pipeline.phases.find((p) => p.id === 'phase-a')!;
    expect(a).toBeDefined();
    expect(a.dependsOn).toEqual([]);
    expect(a.skills).toContain('context-discipline');
  });

  it('phase-b depends on phase-a and has artifact template', () => {
    const b = pipeline.phases.find((p) => p.id === 'phase-b')!;
    expect(b).toBeDefined();
    expect(b.dependsOn).toEqual(['phase-a']);
    expect(b.artifactTemplates).toEqual(['analysis-report']);
  });

  it('phase-c depends on phase-a', () => {
    const c = pipeline.phases.find((p) => p.id === 'phase-c')!;
    expect(c).toBeDefined();
    expect(c.dependsOn).toEqual(['phase-a']);
    expect(c.skills).toEqual([]);
    expect(c.artifactTemplates).toEqual([]);
  });
});

// ─── 2. Agent template parsing ───────────────────────────────────────────────

describe('Agent template parsing', () => {
  const template = parseAgentMdFile(agentPath);

  it('extracts all four directives', () => {
    expect(template.role).toBeTruthy();
    expect(template.goal).toBeTruthy();
    expect(template.constraint).toBeTruthy();
    expect(template.style).toBeTruthy();
  });

  it('ROLE directive is complete', () => {
    expect(template.role!).toContain('senior software engineer');
  });

  it('GOAL directive is present', () => {
    expect(template.goal!).toContain('Execute the assigned pipeline phase');
  });

  it('CONSTRAINT directive contains rules', () => {
    expect(template.constraint!).toContain('Do not skip validation');
    expect(template.constraint!).toContain('Follow the Amber protocol');
  });

  it('STYLE directive is captured', () => {
    expect(template.style!).toContain('Concise, technical');
  });
});

// ─── 3. Skill parsing & discovery ────────────────────────────────────────────

describe('Skill parsing', () => {
  const skillPath = path.join(skillsDir, 'context-discipline', 'SKILL.md');
  const skill = parseSkillMdFile(skillPath);

  it('parses skill name from directory', () => {
    expect(skill.name).toBe('context-discipline');
  });

  it('extracts skill prompt content', () => {
    expect(skill.prompt).toBeTruthy();
    expect(skill.prompt).toContain('防止上下文膨胀');
  });

  it('records the file path', () => {
    expect(skill.path).toContain('context-discipline');
  });
});

describe('Skill discovery', () => {
  const skills = discoverSkills(skillsDir);

  it('discovers context-discipline skill', () => {
    expect(skills.has('context-discipline')).toBe(true);
    const skill = skills.get('context-discipline')!;
    expect(skill.name).toBe('context-discipline');
  });
});

// ─── 4. Topological sort (schedulePhases) ────────────────────────────────────

describe('Topological sort', () => {
  const pipeline = parsePipelineYamlFile(pipelinePath);
  const schedule = schedulePhases(pipeline.phases);
  const scheduleIds = schedule.map((p) => p.id);

  it('returns 3 phases', () => {
    expect(schedule).toHaveLength(3);
  });

  it('phase-a is the first scheduled phase', () => {
    expect(scheduleIds[0]).toBe('phase-a');
  });

  it('phase-a appears before phase-b and phase-c', () => {
    const idxA = scheduleIds.indexOf('phase-a');
    const idxB = scheduleIds.indexOf('phase-b');
    const idxC = scheduleIds.indexOf('phase-c');
    expect(idxA).toBeLessThan(idxB);
    expect(idxA).toBeLessThan(idxC);
  });

  it('all phases from pipeline are present', () => {
    pipeline.phases.forEach((p) => {
      expect(scheduleIds).toContain(p.id);
    });
  });

  it('no duplicate phases in schedule', () => {
    expect(new Set(scheduleIds).size).toBe(schedule.length);
  });
});

// ─── 5. Artifact collection ──────────────────────────────────────────────────

describe('Artifact collection', () => {
  const pipeline = parsePipelineYamlFile(pipelinePath);

  it('collectUpstreamArtifacts — phase has no upstream phases', () => {
    const phaseA = pipeline.phases.find((p) => p.id === 'phase-a')!;
    const result = collectUpstreamArtifacts(phaseA.id, pipeline.phases, new Map());
    // phase-a 的 dependsOn 为空，结果为空数组
    expect(result).toEqual([]);
  });

  it('collectUpstreamArtifacts — phase-b collects from phase-a', () => {
    const phaseB = pipeline.phases.find((p) => p.id === 'phase-b')!;
    // 模拟 phase-a 已产出 artifacts
    const phaseArtifacts = new Map([['phase-a', ['analysis-report']]]);
    const result = collectUpstreamArtifacts(phaseB.id, pipeline.phases, phaseArtifacts);
    expect(result).toContain('@phase-a/analysis-report');
  });
});

// ─── 6. CamelAgentInput assembly ─────────────────────────────────────────────

describe('CamelAgentInput assembly', () => {
  const pipeline = parsePipelineYamlFile(pipelinePath);
  const parsedAgent = parseAgentMdFile(agentPath);
  const skills = discoverSkills(skillsDir);
  const runContext: RunContext = {
    runId: 'test-run',
    sessionId: 'test-session',
    repoPath: '/fake/repo',
    puebloPath: '/fake/pueblo',
    skillPath: skillsDir,
    artifactPath: fixturesRoot,
    agentTemplate: agentPath,
    additionalPrompts: [],
    completedPhases: new Map(),
  };
  const ctx: AmberContext = {
    pipeline,
    parsedAgent,
    skills,
    artifactTemplates: new Map(),
    runContext,
  };

  function callBuilder(phase: Phase) {
    return buildPhaseAgentInput(ctx.runContext, ctx.parsedAgent, ctx.pipeline, ctx.skills, phase.id);
  }

  it('builds valid CamelAgentInput for phase-a', () => {
    const phaseA = pipeline.phases.find((p) => p.id === 'phase-a')!;
    const input = callBuilder(phaseA);

    expect(input.goal).toBe(phaseA.goal);
    expect(input.sessionId).toBe('test-session');
    expect(input.puebloPath).toBe('/fake/pueblo');
    expect(input.skillPath).toBe(skillsDir);
    expect(input.roleDirectives).toBeDefined();
    expect(input.roleDirectives.length).toBeGreaterThanOrEqual(4);
    // Verify ROLE directive is present
    expect(input.roleDirectives.some((d) => d.includes('senior software engineer'))).toBe(true);
    // Verify skill was injected
    expect(input.roleDirectives.some((d) => d.includes('防止上下文膨胀'))).toBe(true);
  });

  it('includes phase goal in roleDirectives', () => {
    const phaseA = pipeline.phases.find((p) => p.id === 'phase-a')!;
    const input = callBuilder(phaseA);
    // Phase goal should appear in roleDirectives
    expect(input.roleDirectives.some((d) => d.includes('Data Collection'))).toBe(true);
  });

  it('includes artifact prompt for phase-b with artifactTemplate', () => {
    const phaseB = pipeline.phases.find((p) => p.id === 'phase-b')!;
    const input = callBuilder(phaseB);
    // Should contain the artifact template name reference
    expect(input.roleDirectives.some((d) => d.includes('analysis-report'))).toBe(true);
  });

  it('budget fields are present', () => {
    const phaseA = pipeline.phases.find((p) => p.id === 'phase-a')!;
    const input = callBuilder(phaseA);
    expect(input.maxSteps).toBeGreaterThan(0);
    expect(input.budgetLimit).toBeGreaterThan(0);
  });
});

// ─── 7. Full amberRun integration ────────────────────────────────────────────

describe('Full resolveAmberContext integration', () => {
  const context = resolveAmberContext({
    pipelinePath,
    agentTemplatePath: agentPath,
    skillsDir,
    artifactsDir: fixturesRoot,
    runContext: {
      sessionId: 'integration-test',
      repoPath: '/fake/repo',
      puebloPath: '/fake/pueblo',
    },
  });

  it('resolves pipeline correctly', () => {
    expect(context.pipeline.phases).toHaveLength(3);
  });

  it('resolves agent template', () => {
    expect(context.agentTemplate.role).toBeTruthy();
  });

  it('resolves skills map', () => {
    expect(context.skills.has('context-discipline')).toBe(true);
  });

  it('schedules phases topologically', () => {
    const schedule = schedulePhases(context.pipeline.phases);
    expect(schedule[0].id).toBe('phase-a');
  });

  it('builds CamelAgentInput for all phases without error', () => {
    const schedule = schedulePhases(context.pipeline.phases);
    for (const phase of schedule) {
      expect(() => buildPhaseAgentInput(phase, context, '/tmp/' + phase.id)).not.toThrow();
    }
  });
});
