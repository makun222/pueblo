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
    expect(template.directives.role.length).toBeGreaterThan(0);
    expect(template.directives.goal.length).toBeGreaterThan(0);
    expect(template.directives.constraint.length).toBeGreaterThan(0);
    expect(template.directives.style.length).toBeGreaterThan(0);
  });

  it('ROLE directive is complete', () => {
    expect(template.directives.role.join('')).toContain('senior software engineer');
  });

  it('GOAL directive is present', () => {
    expect(template.directives.goal.join('')).toContain('Execute the assigned pipeline phase');
  });

  it('CONSTRAINT directive contains rules', () => {
    expect(template.directives.constraint.join('')).toContain('Do not skip validation');
    expect(template.directives.constraint.join('')).toContain('Follow the Amber protocol');
  });

  it('STYLE directive is captured', () => {
    expect(template.directives.style.join('')).toContain('Concise, technical');
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
    skills: new Map([
      ['context-discipline', {
        name: 'context-discipline',
        path: path.join(fixturesRoot, 'skills', 'context-discipline', 'SKILL.md'),
        description: '防止上下文膨胀，保持每轮信息紧凑、可操作',
        summary: '# context-discipline\n\n## 目的\n防止上下文膨胀，保持每轮信息紧凑、可操作。适用于所有对话轮次，尤其长任务。\n\n## 触发时机\n- 每个回复的**收尾阶段**（在完成本轮工作后输出状态块）\n- 当发现自己在重复分析、重复读取已读文件、或引用超过 3 轮前的历史细节时，**立即应用本 Skill**\n\n## 上下文截断规则\n\n### 保留（写入 ENGINEERING NOTE 或 TASK_STATUS）\n| 类别 | 示例 |\n|------|------|\n| 上一轮未完成的 TODO 清单 | `[ ] ipc.ts:351 添加 onProgress` |\n| 本轮已修改的文件+行号+内容摘要 | `ipc.ts L389-395: 添加 MonitorWindow` |\n| 本轮待执行的明确指令 | 用户说"继续"→继续未完成项 |\n| 关键架构约束 | `DesktopLoopJobManager` 构造器签名不一致 |\n\n### 丢弃（不要带入下一轮）\n| 类别 | 示例 |\n|------|------|\n| 多轮重复的根因分析 | "问题在于两条路径..." (只保留第一次结论) |\n| "让我确认一下"的 read 记录 | 中间验证性的文件读取 |\n| 历史 turn 的中间态分析 | 已废弃的方案讨论 |\n| 冗长的文件内容引用 | 超过 10 行的代码块 |\n\n## 输出格式\n\n### 每轮结束必须输出\n\n```\n## TASK_STATUS\n- DONE: N/M\n- TODO: [1] <具体文件:行号> <动作> [2] ...\n- BLOCKED: <阻塞原因 或 none>\n\n## ENGINEERING NOTE (retain)\n- <文件> L<行号>: <决策/变更摘要>\n- ...\n```\n\n### 规则\n- TASK_STATUS 的 TODO 项必须包含**文件路径 + 行号范围 + 具体动作**\n- ENGINEERING NOTE 每项一行，以文件路径开头\n- 如果本轮无变更，ENGINEERING NOTE 可以为空\n- 如果所有 TODO 完成，标记 `DONE: N/N` 并总结\n\n## 反模式（禁止）\n\n1. **禁止重新确认已完成项** — 如果 TASK_STATUS 标记 DONE，不要再次验证\n2. **禁止重新分析根因** — 如果 ENGINEERING NOTE 已有结论，直接引用\n3. **禁止无目的的文件读取** — 只有在需要定位修改点时才 read\n4. **禁止引用超过 2 轮前的历史细节** — 除非在 ENGINEERING NOTE 中有记录\n5. **禁止输出冗长的文件内容** — 引用文件内容时只给出所在行号和简短摘要\n\n## 与 execution-discipline 的协作\n- `execution-discipline` 控制**行为**（连续 edit、禁止中间确认）\n- `context-discipline` 控制**输出**（截断、状态块、ENGINEERING NOTE）\n- 两者不冲突，同时启用\n\n## 验证\n- 每轮回复是否在 100 行以内？\n- 是否包含 TASK_STATUS 块？\n- ENGINEERING NOTE 是否只包含本轮决策/变更？\n- 是否避免了所有 5 项反模式？',
      }],
      ['analysis-report', {
        name: 'analysis-report',
        path: path.join(fixturesRoot, 'skills', 'analysis-report', 'SKILL.md'),
        description: '自动生成比较分析报告',
        summary: '# analysis-report\n\n## 目的\n自动化生成比较分析报告，便于人工与API处理结果的可视化和比较。',
      }],
    ]),
    artifactTemplates: new Map([
      ['analysis-report', { name: 'analysis-report', sections: [], anchor: '' }],
    ]),
    runContext,
  };

  function callBuilder(phase: Phase) {
    return buildPhaseAgentInput(ctx.runContext, ctx.parsedAgent, ctx.pipeline, ctx.skills, phase.id, ctx.artifactTemplates);
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
    expect(input.roleDirectives.some((d) => d.includes('Data—Collection'))).toBe(true);
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
      skillPath: '/fake/skills',
      completedPhases: new Map(),
      additionalPrompts: [] as string[],
    },
  });

  it('resolves pipeline correctly', () => {
    expect(context.pipeline.phases).toHaveLength(3);
  });

  it('resolves agent template', () => {
    expect(context.agentTemplate.directives.role.length).toBeGreaterThan(0);
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
