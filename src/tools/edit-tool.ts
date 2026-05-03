import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from './glob-tool';

export interface EditToolRequest {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly cwd: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

interface EditScope {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly label: string;
}

export interface EditApprovalPreview {
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
}

export function createEditTool() {
  return async (request: EditToolRequest): Promise<ToolExecutionResult> => {
    try {
      const preparedEdit = prepareEditRequest(request);

      if (preparedEdit.matchCount === 0) {
        return {
          toolName: 'edit',
          status: 'failed',
          summary: `Exact text to replace was not found in ${preparedEdit.relativePath}${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}`,
          output: [],
        };
      }

      if (preparedEdit.matchCount > 1) {
        return {
          toolName: 'edit',
          status: 'failed',
          summary: `Exact text to replace matched ${preparedEdit.matchCount} times in ${preparedEdit.relativePath}${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}; edit is ambiguous`,
          output: [],
        };
      }

      const nextScopedContent = preparedEdit.scopedContent.replace(preparedEdit.normalizedOldText, preparedEdit.normalizedNewText);
      const nextNormalizedContent = `${preparedEdit.normalizedContent.slice(0, preparedEdit.scope.startOffset)}${nextScopedContent}${preparedEdit.normalizedContent.slice(preparedEdit.scope.endOffset)}`;
      const nextContent = restoreLineEndings(nextNormalizedContent, preparedEdit.preferredLineEnding);
      fs.writeFileSync(preparedEdit.absolutePath, nextContent, 'utf8');

      return {
        toolName: 'edit',
        status: 'succeeded',
        summary: `Edited ${preparedEdit.relativePath} by replacing one exact match${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}`,
        output: [
          `path: ${preparedEdit.relativePath}`,
          `scope: ${preparedEdit.scope.label}`,
          `oldTextChars: ${request.oldText.length}`,
          `newTextChars: ${request.newText.length}`,
        ],
      };
    } catch (error) {
      return {
        toolName: 'edit',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Edit execution failed',
        output: [],
      };
    }
  };
}

export function buildEditApprovalPreview(request: EditToolRequest): EditApprovalPreview {
  const pathLabel = request.path.trim() || '<missing path>';
  const scopeLabel = request.startLine !== undefined && request.endLine !== undefined
    ? `lines ${request.startLine}-${request.endLine}`
    : 'file';

  try {
    const preparedEdit = prepareEditRequest(request);
    const matchSummary = preparedEdit.matchCount === 1
      ? 'Current file check: 1 exact match in scope'
      : preparedEdit.matchCount === 0
        ? 'Current file check: no exact match in scope'
        : `Current file check: ${preparedEdit.matchCount} exact matches in scope`;

    return {
      title: `Allow edit in ${preparedEdit.relativePath}?`,
      summary: buildEditPreviewSummary(preparedEdit.relativePath, preparedEdit.scope.label, request.oldText, request.newText),
      detail: [
        `Path: ${preparedEdit.relativePath}`,
        `Scope: ${preparedEdit.scope.label}`,
        matchSummary,
        formatDiffPreview(preparedEdit.scope.label, request.oldText, request.newText, {
          oldPrefix: '-',
          newPrefix: '+',
          maxLinesPerSide: 10,
          headTail: false,
        }),
      ].join('\n\n'),
    };
  } catch (error) {
    return {
      title: `Allow edit in ${pathLabel}?`,
      summary: buildEditPreviewSummary(pathLabel, scopeLabel, request.oldText, request.newText),
      detail: [
        `Path: ${pathLabel}`,
        `Scope: ${scopeLabel}`,
        `Current file check: unavailable (${error instanceof Error ? error.message : 'unknown error'})`,
        formatDiffPreview(scopeLabel, request.oldText, request.newText, {
          oldPrefix: '-',
          newPrefix: '+',
          maxLinesPerSide: 10,
          headTail: false,
        }),
      ].join('\n\n'),
    };
  }
}

interface PreparedEditRequest {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly preferredLineEnding: '\n' | '\r\n';
  readonly normalizedContent: string;
  readonly normalizedOldText: string;
  readonly normalizedNewText: string;
  readonly scope: EditScope;
  readonly scopedContent: string;
  readonly matchCount: number;
}

function prepareEditRequest(request: EditToolRequest): PreparedEditRequest {
  validateEditRequest(request);

  const requestedPath = request.path.trim();
  const workspaceRoot = path.resolve(request.cwd);
  const absolutePath = resolveRequestedPath(workspaceRoot, requestedPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Path must stay within the workspace root');
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error('Path does not point to a file');
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const normalizedContent = normalizeLineEndings(content);
  const normalizedOldText = normalizeLineEndings(request.oldText);
  const normalizedNewText = normalizeLineEndings(request.newText);
  const scope = resolveEditScope(normalizedContent, request.startLine, request.endLine);
  const scopedContent = normalizedContent.slice(scope.startOffset, scope.endOffset);

  return {
    absolutePath,
    relativePath,
    preferredLineEnding: detectPreferredLineEnding(content),
    normalizedContent,
    normalizedOldText,
    normalizedNewText,
    scope,
    scopedContent,
    matchCount: countOccurrences(scopedContent, normalizedOldText),
  };
}

function validateEditRequest(request: EditToolRequest): void {
  const requestedPath = request.path.trim();
  if (!requestedPath) {
    throw new Error('Path is required');
  }

  if (!request.oldText) {
    throw new Error('oldText is required');
  }

  if ((request.startLine === undefined) !== (request.endLine === undefined)) {
    throw new Error('startLine and endLine must be provided together');
  }

  if (
    request.startLine !== undefined
    && request.endLine !== undefined
    && request.startLine > request.endLine
  ) {
    throw new Error('startLine must be less than or equal to endLine');
  }
}

function resolveRequestedPath(workspaceRoot: string, requestedPath: string): string {
  const normalizedRequestedPath = path.normalize(requestedPath);
  return path.isAbsolute(normalizedRequestedPath)
    ? normalizedRequestedPath
    : path.resolve(workspaceRoot, normalizedRequestedPath);
}

function buildEditPreviewSummary(relativePath: string, scopeLabel: string, oldText: string, newText: string): string {
  return [
    `${relativePath} @ ${scopeLabel}`,
    formatDiffPreview(scopeLabel, oldText, newText, {
      oldPrefix: '-',
      newPrefix: '+',
      maxLinesPerSide: 4,
      headTail: true,
    }),
  ].join('\n');
}

function formatDiffPreview(
  scopeLabel: string,
  oldText: string,
  newText: string,
  options: {
    readonly oldPrefix: '-';
    readonly newPrefix: '+';
    readonly maxLinesPerSide: number;
    readonly headTail: boolean;
  },
): string {
  const oldLines = toPreviewLines(oldText);
  const newLines = toPreviewLines(newText);

  return [
    `@@ ${scopeLabel} @@`,
    ...formatPreviewLines(oldLines, options.oldPrefix, options.maxLinesPerSide, options.headTail),
    ...formatPreviewLines(newLines, options.newPrefix, options.maxLinesPerSide, options.headTail),
  ].join('\n');
}

function toPreviewLines(content: string): string[] {
  const normalizedContent = normalizeLineEndings(content);
  return normalizedContent.length === 0 ? ['<empty>'] : normalizedContent.split('\n');
}

function formatPreviewLines(
  lines: readonly string[],
  prefix: '-' | '+',
  maxLines: number,
  headTail: boolean,
): string[] {
  const selectedLines = headTail ? selectHeadTailLines(lines, maxLines) : selectLeadingLines(lines, maxLines);
  return selectedLines.map((line) => `${prefix} ${truncatePreviewLine(line)}`);
}

function selectLeadingLines(lines: readonly string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return [...lines];
  }

  return [
    ...lines.slice(0, maxLines),
    `... (${lines.length - maxLines} more lines)`,
  ];
}

function selectHeadTailLines(lines: readonly string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return [...lines];
  }

  const headCount = Math.max(1, Math.floor(maxLines / 2));
  const tailCount = Math.max(1, maxLines - headCount);
  return [
    ...lines.slice(0, headCount),
    `... (${lines.length - headCount - tailCount} more lines)`,
    ...lines.slice(-tailCount),
  ];
}

function truncatePreviewLine(line: string): string {
  return line.length <= 140 ? line : `${line.slice(0, 137)}...`;
}

function resolveEditScope(content: string, startLine?: number, endLine?: number): EditScope {
  if (startLine === undefined || endLine === undefined) {
    return {
      startOffset: 0,
      endOffset: content.length,
      label: 'file',
    };
  }

  const lines = splitIntoLogicalLines(content);
  if (startLine < 1 || endLine < 1 || startLine > lines.length || endLine > lines.length) {
    throw new Error(`Line range ${startLine}-${endLine} is outside the file bounds (1-${lines.length})`);
  }

  const lineStarts = computeLineStarts(lines);
  return {
    startOffset: lineStarts[startLine - 1],
    endOffset: lineStarts[endLine - 1] + lines[endLine - 1].length,
    label: `lines ${startLine}-${endLine}`,
  };
}

function splitIntoLogicalLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }

  return lines;
}

function computeLineStarts(lines: readonly string[]): number[] {
  const lineStarts: number[] = [];
  let currentOffset = 0;

  for (const line of lines) {
    lineStarts.push(currentOffset);
    currentOffset += line.length + 1;
  }

  return lineStarts;
}

function detectPreferredLineEnding(content: string): '\n' | '\r\n' {
  const withoutCrLf = content.replace(/\r\n/g, '');
  return content.includes('\r\n') && !withoutCrLf.includes('\n') ? '\r\n' : '\n';
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function restoreLineEndings(content: string, lineEnding: '\n' | '\r\n'): string {
  if (lineEnding === '\n') {
    return content;
  }

  return content.replace(/\n/g, '\r\n');
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let startIndex = 0;

  while (startIndex <= content.length) {
    const matchIndex = content.indexOf(search, startIndex);
    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = matchIndex + search.length;
  }

  return count;
}