import type { CamelTurnContext } from './camel-types.js';

/**
 * 从 CamelTurnContext 提取所有系统提示词相关的上下文摘要字段。
 * contextSummary 是 Record<string, unknown>，此处做类型安全的提取。
 */
function getSummaryFields(context: CamelTurnContext): {
  goal: string;
  roleDirectives: string[];
  targetDirectory: string | undefined;
  puebloPath: string | undefined;
  skillPath: string | undefined;
  additionalPrompts: string[];
} {
  const s = context.contextSummary;
  const goal =
    typeof s['goal'] === 'string' ? s['goal'] : '';

  const rawRole = s['roleDirectives'];
  const roleDirectives = Array.isArray(rawRole)
    ? rawRole.filter((x): x is string => typeof x === 'string')
    : [];

  const targetDirectory =
    typeof s['targetDirectory'] === 'string'
      ? s['targetDirectory']
      : undefined;

  const puebloPath =
    typeof s['puebloPath'] === 'string' ? s['puebloPath'] : undefined;

  const skillPath =
    typeof s['skillPath'] === 'string' ? s['skillPath'] : undefined;

  const rawPrompts = s['additionalPrompts'];
  const additionalPrompts = Array.isArray(rawPrompts)
    ? rawPrompts.filter((x): x is string => typeof x === 'string')
    : [];

  return { goal, roleDirectives, targetDirectory, puebloPath, skillPath, additionalPrompts };
}

/**
 * 从 CamelTurnContext 构建单一系统提示词消息。
 *
 * 返回格式：chatMessages[0] = { role: 'system', content: ... }
 * content 由以下可选段组成（按顺序用双换行分隔）：
 *     1. ## 角色指令（如有）
 *     2. ## 路径约束（如有）
 *     3. ## 附加提示（如有）
 *     4. ## 目标（如有）
 *
 * 当 content 为空时返回兜底消息 "No goal specified."
 */
export function buildCamelSystemMessages(
    context: CamelTurnContext,
): Array<{ role: 'system'; content: string }> {
    const fields = getSummaryFields(context);
    const sections: string[] = [];

    // 1. 角色指令
    const roleLines: string[] = [];
    if (fields.roleDirectives.length > 0) {
        for (const d of fields.roleDirectives) {
            roleLines.push(d);
        }
    }
    if (roleLines.length > 0) {
        sections.push(`##角色指令\n\n${roleLines.join('\n')}`);
    }

    // 2. 路径约束
    const pathLines: string[] = [];
    if (fields.targetDirectory) pathLines.push(`- 目标仓库: ${fields.targetDirectory}`);
    if (fields.puebloPath) pathLines.push(`- Pueblo框架: ${fields.puebloPath}`);
    if (fields.skillPath) pathLines.push(`- Skill工作空间: ${fields.skillPath}`);
    if (pathLines.length > 0) {
        sections.push(`##路径约束\n\n${pathLines.join('\n')}`);
    }

    // 3. 附加提示
    const promptLines: string[] = [];
    if (fields.additionalPrompts.length > 0) {
        for (let i = 0; i < fields.additionalPrompts.length; i++) {
            promptLines.push(`${i + 1}. ${fields.additionalPrompts[i]}`);
        }
    }
    if (promptLines.length > 0) {
        sections.push(`##附加提示\n\n${promptLines.join('\n')}`);
    }

    // 4. 目标
    if (fields.goal) {
        sections.push(`##目标\n\n${fields.goal}`);
    }

    const content = sections.join('\n\n');
    const fallback = content || 'No goal specified.';

    return [{ role: 'system', content: fallback }];
}

