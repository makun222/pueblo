import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from './glob-tool';
import type { RendererFileChange } from '../shared/schema';
import { inspectAttachmentAssetContent, maybeExportAttachmentAssetFromContent } from './attachment-asset-export';
import { isAutoSaveEnabled } from '../shared/auto-save-state';
import { SnapshotEngine } from '../shared/snapshot-engine';

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

export interface EditReviewRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
  readonly shadowPath: string;
  readonly fileChange: RendererFileChange;
}

export type EditReviewDecision = 'keep' | 'discard';

export type EditReviewHandler = (request: EditReviewRequest) => Promise<EditReviewDecision>;

interface EditToolOptions {
  readonly getReviewHandler?: () => EditReviewHandler | null;
  readonly shadowRoot?: string | (() => string);
}

interface PendingEditOutcome {
  readonly workspaceRoot: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly preferredLineEnding: '\n' | '\r\n';
  readonly previousContent: string;
  readonly nextContent: string;
  readonly changeType: RendererFileChange['changeType'];
  readonly scopeLabel: string;
  readonly output: string[];
  readonly successSummary: string;
  readonly reviewDetail: string;
  readonly fileExistedBefore: boolean;
}

export function createEditTool(options: EditToolOptions = {}) {
  return async (request: EditToolRequest): Promise<ToolExecutionResult> => {
    try {
      const pendingEdit = isCreateFileEdit(request)
        ? prepareCreateFileOutcome(request)
        : prepareTextEditOutcome(request);

      const reviewHandler = options.getReviewHandler?.() ?? null;

      // Path B: auto-save ON — snapshot-before-write + direct overwrite
      if (isAutoSaveEnabled()) {
        const snapshotEngine = new SnapshotEngine(request.cwd, {
          maxSnapshotsPerFile: 50,
          ttlDays: 7,
        });
        if (pendingEdit.fileExistedBefore) {
          await snapshotEngine.createSnapshot(pendingEdit.absolutePath);
        } else {
          await snapshotEngine.createNullSnapshot(pendingEdit.absolutePath);
        }
        return applyPendingEditOutcome(pendingEdit);
      }

      // Path A: auto-save OFF — existing review / shadow-edit flow
      if (!reviewHandler) {
        return applyPendingEditOutcome(pendingEdit);
      }

      const reviewRequest = materializeEditReviewRequest(pendingEdit, request, options.shadowRoot);

      try {
        const decision = await reviewHandler(reviewRequest);

        if (decision === 'discard') {
          return {
            toolName: 'edit',
            status: 'failed',
            summary: `Discarded staged ${pendingEdit.changeType === 'created' ? 'file creation' : 'edit'} for ${pendingEdit.relativePath}; workspace unchanged`,
            output: [
              `path: ${pendingEdit.relativePath}`,
              `scope: ${pendingEdit.scopeLabel}`,
              'decision: discard',
            ],
          };
        }

        const result = await applyPendingEditOutcome(pendingEdit);
        return {
          ...result,
          output: [...result.output, 'decision: keep'],
        };
      } finally {
        cleanupShadowReviewFile(reviewRequest.shadowPath);
      }
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
  const scopeLabel = describeEditScope(request.startLine, request.endLine);

  try {
    if (isCreateFileEdit(request)) {
      return buildCreateFileApprovalPreview(request);
    }

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

interface ResolvedEditPath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function prepareEditRequest(request: EditToolRequest): PreparedEditRequest {
  validateEditRequest(request);

  const requestedPath = request.path.trim();
  const workspaceRoot = path.resolve(request.cwd);
  const { absolutePath, relativePath } = resolveEditPath(workspaceRoot, requestedPath);

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

  if (request.oldText.length === 0 && (request.startLine !== undefined || request.endLine !== undefined)) {
    throw new Error('startLine and endLine are not supported when oldText is empty');
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

function resolveEditPath(workspaceRoot: string, requestedPath: string): ResolvedEditPath {
  const absolutePath = resolveRequestedPath(workspaceRoot, requestedPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Path must stay within the workspace root');
  }

  return {
    absolutePath,
    relativePath,
  };
}

function isCreateFileEdit(request: EditToolRequest): boolean {
  return request.oldText.length === 0;
}

function prepareTextEditOutcome(request: EditToolRequest): PendingEditOutcome {
  const preparedEdit = prepareEditRequest(request);

  if (preparedEdit.matchCount === 0) {
    throw new Error(`Exact text to replace was not found in ${preparedEdit.relativePath}${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}`);
  }

  if (preparedEdit.matchCount > 1) {
    throw new Error(`Exact text to replace matched ${preparedEdit.matchCount} times in ${preparedEdit.relativePath}${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}; edit is ambiguous`);
  }

  const nextScopedContent = preparedEdit.scopedContent.replace(preparedEdit.normalizedOldText, preparedEdit.normalizedNewText);
  const nextNormalizedContent = `${preparedEdit.normalizedContent.slice(0, preparedEdit.scope.startOffset)}${nextScopedContent}${preparedEdit.normalizedContent.slice(preparedEdit.scope.endOffset)}`;
  const nextContent = restoreLineEndings(nextNormalizedContent, preparedEdit.preferredLineEnding);

  return {
    workspaceRoot: path.resolve(request.cwd),
    absolutePath: preparedEdit.absolutePath,
    relativePath: preparedEdit.relativePath,
    preferredLineEnding: preparedEdit.preferredLineEnding,
    previousContent: restoreLineEndings(preparedEdit.normalizedContent, preparedEdit.preferredLineEnding),
    nextContent,
    changeType: 'modified',
    scopeLabel: preparedEdit.scope.label,
    output: [
      `path: ${preparedEdit.relativePath}`,
      `scope: ${preparedEdit.scope.label}`,
      `oldTextChars: ${request.oldText.length}`,
      `newTextChars: ${request.newText.length}`,
    ],
    successSummary: `Edited ${preparedEdit.relativePath} by replacing one exact match${preparedEdit.scope.label === 'file' ? '' : ` within ${preparedEdit.scope.label}`}`,
    reviewDetail: [
      `Path: ${preparedEdit.relativePath}`,
      `Scope: ${preparedEdit.scope.label}`,
      formatDiffPreview(preparedEdit.scope.label, request.oldText, request.newText, {
        oldPrefix: '-',
        newPrefix: '+',
        maxLinesPerSide: 10,
        headTail: false,
      }),
    ].join('\n\n'),
    fileExistedBefore: true,
  };
}

function prepareCreateFileOutcome(request: EditToolRequest): PendingEditOutcome {
  validateEditRequest(request);

  const workspaceRoot = path.resolve(request.cwd);
  const { absolutePath, relativePath } = resolveEditPath(workspaceRoot, request.path.trim());
  const fileExists = fs.existsSync(absolutePath);
  let previousContent = '';
  let changeType: RendererFileChange['changeType'] = 'created';
  let successSummary = `Created ${relativePath}`;

  if (fileExists) {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error('Path does not point to a file');
    }

    previousContent = fs.readFileSync(absolutePath, 'utf8');
    if (previousContent.length > 0) {
      throw new Error(`Cannot create ${relativePath} with empty oldText because the file already exists and is not empty`);
    }

    changeType = 'modified';
    successSummary = `Initialized empty file ${relativePath}`;
  }

  return {
    workspaceRoot,
    absolutePath,
    relativePath,
    preferredLineEnding: detectPreferredLineEnding(previousContent),
    previousContent,
    nextContent: request.newText,
    changeType,
    scopeLabel: 'new file',
    output: [
      `path: ${relativePath}`,
      'scope: new file',
      `oldTextChars: ${request.oldText.length}`,
      `newTextChars: ${request.newText.length}`,
    ],
    successSummary,
    reviewDetail: [
      `Path: ${relativePath}`,
      'Scope: new file',
      formatDiffPreview('new file', request.oldText, request.newText, {
        oldPrefix: '-',
        newPrefix: '+',
        maxLinesPerSide: 10,
        headTail: false,
      }),
    ].join('\n\n'),
    fileExistedBefore: fileExists,
  };
}

async function applyPendingEditOutcome(pendingEdit: PendingEditOutcome): Promise<ToolExecutionResult> {
  const previousAssetInspection = inspectAttachmentAssetContent(pendingEdit.previousContent);
  const nextAssetInspection = inspectAttachmentAssetContent(pendingEdit.nextContent);

  try {
    fs.mkdirSync(path.dirname(pendingEdit.absolutePath), { recursive: true });
    fs.writeFileSync(pendingEdit.absolutePath, pendingEdit.nextContent, 'utf8');

    let exportedAttachmentSummary: string | null = null;
    let exportedSourceFileChange: RendererFileChange | null = null;

    const exportResult = await maybeExportAttachmentAssetFromContent({
      assetPath: pendingEdit.absolutePath,
      content: pendingEdit.nextContent,
    });

    if (exportResult) {
      exportedAttachmentSummary = `Exported ${exportResult.sourceFileName} from edited attachment JSON`;
      if (
        previousAssetInspection
        && nextAssetInspection
        && previousAssetInspection.sourcePath === exportResult.exportedPath
        && nextAssetInspection.sourcePath === exportResult.exportedPath
      ) {
        exportedSourceFileChange = createAttachmentExportFileChange({
          workspaceRoot: pendingEdit.workspaceRoot,
          absolutePath: exportResult.exportedPath,
          previousContent: previousAssetInspection.previewContent,
          currentContent: nextAssetInspection.previewContent,
        });
      }
    }

    return {
      toolName: 'edit',
      status: 'succeeded',
      summary: exportedAttachmentSummary
        ? `${pendingEdit.successSummary}; ${exportedAttachmentSummary}`
        : pendingEdit.successSummary,
      output: [
        ...pendingEdit.output,
        ...(exportedAttachmentSummary ? [exportedAttachmentSummary] : []),
      ],
      fileChanges: [createRendererFileChange({
        absolutePath: pendingEdit.absolutePath,
        relativePath: pendingEdit.relativePath,
        changeType: pendingEdit.changeType,
        previousContent: pendingEdit.previousContent,
        currentContent: pendingEdit.nextContent,
      }), ...(exportedSourceFileChange ? [exportedSourceFileChange] : [])],
    };
  } catch (error) {
    restorePendingEditTarget(pendingEdit);
    throw error;
  }
}

function materializeEditReviewRequest(
  pendingEdit: PendingEditOutcome,
  request: EditToolRequest,
  shadowRoot: string | (() => string) | undefined,
): EditReviewRequest {
  const reviewId = `${Date.now()}-edit-review-${Math.random().toString(16).slice(2)}`;
  const resolvedShadowRoot = resolveShadowRoot(shadowRoot, pendingEdit.workspaceRoot);
  const shadowPath = path.resolve(resolvedShadowRoot, reviewId, pendingEdit.relativePath);

  fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
  fs.writeFileSync(shadowPath, pendingEdit.nextContent, 'utf8');

  return {
    id: reviewId,
    toolCallId: reviewId,
    title: pendingEdit.changeType === 'created'
      ? `Keep staged file creation for ${pendingEdit.relativePath}?`
      : `Keep staged edit for ${pendingEdit.relativePath}?`,
    summary: pendingEdit.changeType === 'created'
      ? `Review the staged file creation before replacing the workspace copy for ${pendingEdit.relativePath}.`
      : `Review the staged file edit before replacing the workspace copy for ${pendingEdit.relativePath}.`,
    detail: [
      pendingEdit.reviewDetail,
      `Shadow path: ${shadowPath}`,
      `Requested path: ${request.path.trim()}`,
    ].join('\n\n'),
    shadowPath,
    fileChange: createRendererFileChange({
      absolutePath: pendingEdit.absolutePath,
      relativePath: pendingEdit.relativePath,
      changeType: pendingEdit.changeType,
      previousContent: pendingEdit.previousContent,
      currentContent: pendingEdit.nextContent,
    }),
  };
}

function resolveShadowRoot(shadowRoot: string | (() => string) | undefined, workspaceRoot: string): string {
  if (typeof shadowRoot === 'function') {
    return path.resolve(shadowRoot());
  }

  if (shadowRoot) {
    return path.resolve(shadowRoot);
  }

  return path.resolve(workspaceRoot, '.pueblo', 'shadow-edits');
}

function cleanupShadowReviewFile(shadowPath: string): void {
  const reviewRoot = path.dirname(path.dirname(shadowPath));
  if (fs.existsSync(reviewRoot)) {
    fs.rmSync(reviewRoot, { recursive: true, force: true });
  }
}

function restorePendingEditTarget(pendingEdit: PendingEditOutcome): void {
  if (!pendingEdit.fileExistedBefore) {
    if (fs.existsSync(pendingEdit.absolutePath)) {
      fs.rmSync(pendingEdit.absolutePath, { force: true });
    }
    return;
  }

  fs.mkdirSync(path.dirname(pendingEdit.absolutePath), { recursive: true });
  fs.writeFileSync(pendingEdit.absolutePath, pendingEdit.previousContent, 'utf8');
}

function buildCreateFileApprovalPreview(request: EditToolRequest): EditApprovalPreview {
  validateEditRequest(request);

  const workspaceRoot = path.resolve(request.cwd);
  const { absolutePath, relativePath } = resolveEditPath(workspaceRoot, request.path.trim());
  let fileCheckSummary = 'Current file check: file will be created';

  if (fs.existsSync(absolutePath)) {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      fileCheckSummary = 'Current file check: path exists and is not a file';
    } else if (fs.readFileSync(absolutePath, 'utf8').length === 0) {
      fileCheckSummary = 'Current file check: empty file will be initialized';
    } else {
      fileCheckSummary = 'Current file check: file already exists and is not empty';
    }
  }

  return {
    title: `Allow edit in ${relativePath}?`,
    summary: buildEditPreviewSummary(relativePath, 'new file', request.oldText, request.newText),
    detail: [
      `Path: ${relativePath}`,
      'Scope: new file',
      fileCheckSummary,
      formatDiffPreview('new file', request.oldText, request.newText, {
        oldPrefix: '-',
        newPrefix: '+',
        maxLinesPerSide: 10,
        headTail: false,
      }),
    ].join('\n\n'),
  };
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
  if (startLine === undefined && endLine === undefined) {
    return {
      startOffset: 0,
      endOffset: content.length,
      label: 'file',
    };
  }

  const lines = splitIntoLogicalLines(content);
  const normalizedStartLine = startLine ?? 1;
  const normalizedEndLine = endLine ?? lines.length;

  if (
    normalizedStartLine < 1
    || normalizedEndLine < 1
    || normalizedStartLine > lines.length
    || normalizedEndLine > lines.length
  ) {
    throw new Error(`Line range ${normalizedStartLine}-${normalizedEndLine} is outside the file bounds (1-${lines.length})`);
  }

  const lineStarts = computeLineStarts(lines);
  return {
    startOffset: lineStarts[normalizedStartLine - 1],
    endOffset: lineStarts[normalizedEndLine - 1] + lines[normalizedEndLine - 1].length,
    label: describeEditScope(startLine, endLine),
  };
}

function describeEditScope(startLine?: number, endLine?: number): string {
  if (startLine !== undefined && endLine !== undefined) {
    return `lines ${startLine}-${endLine}`;
  }

  if (startLine !== undefined) {
    return `line ${startLine} onward`;
  }

  if (endLine !== undefined) {
    return `lines 1-${endLine}`;
  }

  return 'file';
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
  if (search.length === 0) {
    return 0;
  }

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

function createRendererFileChange(input: {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly changeType: RendererFileChange['changeType'];
  readonly previousContent: string;
  readonly currentContent: string;
}): RendererFileChange {
  return {
    path: input.relativePath,
    absolutePath: input.absolutePath,
    changeType: input.changeType,
    previousContent: input.previousContent,
    currentContent: input.currentContent,
  };
}

function createAttachmentExportFileChange(input: {
  readonly workspaceRoot: string;
  readonly absolutePath: string;
  readonly previousContent: string;
  readonly currentContent: string;
}): RendererFileChange {
  const relativePath = path.relative(input.workspaceRoot, input.absolutePath);
  const displayPath = relativePath.startsWith('..') || path.isAbsolute(relativePath)
    ? input.absolutePath
    : relativePath;

  return createRendererFileChange({
    absolutePath: input.absolutePath,
    relativePath: displayPath,
    changeType: 'modified',
    previousContent: input.previousContent,
    currentContent: input.currentContent,
  });
}