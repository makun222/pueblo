import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionResult } from './glob-tool';
import { checkFileReadable } from './file-guard';
import { isImagePath, probeImageFileSync, toImageDataUrl } from './image-format';

/**
 * 读取图片文件：探测格式/体积 → 生成 imageParts。
 * 图片内容不能当文本读入，交由 agent loop 转成后续 user 消息的 image part。
 */
function readImageFile(absolutePath: string, normalizedRelativePath: string): ToolExecutionResult {
  const probe = probeImageFileSync(absolutePath);
  if (!probe.ok) {
    const detail = probe.detail ? `: ${probe.detail}` : '';
    return {
      toolName: 'read',
      status: 'failed',
      summary: `Image could not be read (${probe.reason}${detail}): ${normalizedRelativePath}`,
      output: [],
    };
  }

  const imageBuffer = fs.readFileSync(absolutePath);
  const kib = Math.max(1, Math.round(probe.sizeBytes / 1024));
  return {
    toolName: 'read',
    status: 'succeeded',
    summary: `Image (${probe.mimeType}, ${kib} KiB) loaded from ${normalizedRelativePath}; attached to the next user message as an image part (vision models only).`,
    output: [`image: ${normalizedRelativePath}`],
    imageParts: [
      {
        dataUrl: toImageDataUrl(imageBuffer, probe.mimeType),
        mimeType: probe.mimeType,
      },
    ],
  } as ToolExecutionResult;
}

export interface ReadToolRequest {
  readonly path: string;
  readonly cwd: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly limit?: number;
}

const MAX_READ_LINES = resolveMaxReadLines();
const MAX_READ_CHARS = resolveMaxReadChars();

function resolveMaxReadLines(): number {
  const raw = process.env.PUEBLO_READ_MAX_LINES;
  if (raw === undefined || raw === '') {
    return 800;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 800;
}

function resolveMaxReadChars(): number {
  const raw = process.env.PUEBLO_READ_MAX_CHARS;
  if (raw === undefined || raw === '') {
    return 40000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 40000;
}

export function createReadTool() {
  return async (request: ReadToolRequest): Promise<ToolExecutionResult> => {
    const requestedPath = request.path.trim();

    if (!requestedPath) {
      return {
        toolName: 'read',
        status: 'failed',
        summary: 'Path is required',
        output: [],
      };
    }

    try {
      const workspaceRoot = path.resolve(request.cwd);
      const absolutePath = resolveRequestedPath(workspaceRoot, requestedPath);
      const normalizedRelativePath = path.relative(workspaceRoot, absolutePath);

      if (normalizedRelativePath.startsWith('..') || path.isAbsolute(normalizedRelativePath)) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: 'Path must stay within the workspace root',
          output: [],
        };
      }

      if (
        request.startLine !== undefined
        && request.endLine !== undefined
        && request.startLine > request.endLine
      ) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: 'startLine must be less than or equal to endLine',
          output: [],
        };
      }

      if (isImagePath(absolutePath)) {
        return readImageFile(absolutePath, normalizedRelativePath);
      }

      const guard = checkFileReadable(absolutePath);
      if (!guard.ok) {
        return {
          toolName: 'read',
          status: 'failed',
          summary: buildFileGuardSummary(guard.reason, guard.detail, normalizedRelativePath),
          output: [],
        };
      }

      const content = fs.readFileSync(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;
      const startIndex = request.startLine ? Math.max(0, request.startLine - 1) : 0;
      const endIndex = request.endLine ? Math.min(totalLines, request.endLine) : totalLines;
      const effectiveLimit = resolveEffectiveLineLimit(request.limit);

      const selectedLines = lines.slice(startIndex, endIndex);
      const output: string[] = [];
      let totalChars = 0;

      for (let index = 0; index < selectedLines.length && output.length < effectiveLimit; index += 1) {
        const lineNumber = startIndex + index + 1;
        const numberedLine = `${lineNumber}: ${selectedLines[index]}`;
        if (totalChars + numberedLine.length > MAX_READ_CHARS && output.length > 0) {
          break;
        }

        output.push(numberedLine);
        totalChars += numberedLine.length;
      }

      const returnedLineCount = output.length;
      const hasMore = startIndex + returnedLineCount < totalLines;
      const nextStartLine = hasMore ? startIndex + returnedLineCount + 1 : undefined;
      const rangeLabel = buildReadRangeLabel(request.startLine, request.endLine);

      const summary = buildReadSummary({
        returnedLineCount,
        selectedLineCount: selectedLines.length,
        totalLines,
        hasMore,
        rangeLabel,
        normalizedRelativePath,
      });

      return {
        toolName: 'read',
        status: returnedLineCount > 0 ? 'succeeded' : 'empty',
        summary,
        output,
        totalLines,
        hasMore,
        nextStartLine,
      } as ToolExecutionResult;
    } catch (error) {
      return {
        toolName: 'read',
        status: 'failed',
        summary: error instanceof Error ? error.message : 'Read execution failed',
        output: [],
      };
    }
  };
}

function resolveEffectiveLineLimit(requestedLimit: number | undefined): number {
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit) || requestedLimit <= 0) {
    return MAX_READ_LINES;
  }
  return Math.min(Math.floor(requestedLimit), MAX_READ_LINES);
}

function buildReadSummary(params: {
  returnedLineCount: number;
  selectedLineCount: number;
  totalLines: number;
  hasMore: boolean;
  rangeLabel: string;
  normalizedRelativePath: string;
}): string {
  const { returnedLineCount, selectedLineCount, totalLines, hasMore, rangeLabel, normalizedRelativePath } = params;
  const truncated = returnedLineCount < selectedLineCount;
  const readPart = truncated
    ? `Read ${returnedLineCount} of ${selectedLineCount} line(s) from${rangeLabel}`
    : `Read ${selectedLineCount} line(s) from${rangeLabel}`;
  const filePart = ` ${normalizedRelativePath}`;
  const metaPart = ` (file has ${totalLines} line(s)${hasMore ? `, more available` : ''})`;
  return `${readPart}${filePart}${metaPart}`;
}

function buildFileGuardSummary(reason: string, detail: string | undefined, relativePath: string): string {
  switch (reason) {
    case 'not-found':
      return `File not found: ${relativePath}`;
    case 'not-a-file':
      return `Path does not point to a file: ${relativePath}`;
    case 'too-large':
      return `File is too large to read (${detail ?? 'exceeds limit'}): ${relativePath}`;
    case 'unreadable-extension':
      return `File has an unreadable extension (${detail ?? ''}): ${relativePath}`;
    case 'binary-content':
      return `File appears to be binary and was skipped: ${relativePath}`;
    case 'open-failed':
      return `File could not be opened (${detail ?? 'unknown error'}): ${relativePath}`;
    default:
      return `File is not readable: ${relativePath}`;
  }
}

function resolveRequestedPath(workspaceRoot: string, requestedPath: string): string {
  const normalizedRequestedPath = path.normalize(requestedPath);
  return path.isAbsolute(normalizedRequestedPath)
    ? normalizedRequestedPath
    : path.resolve(workspaceRoot, normalizedRequestedPath);
}

function buildReadRangeLabel(startLine?: number, endLine?: number): string {
  if (startLine !== undefined && endLine !== undefined) {
    return ` lines ${startLine}-${endLine}`;
  }

  if (startLine !== undefined) {
    return ` line ${startLine} onward`;
  }

  if (endLine !== undefined) {
    return ` lines 1-${endLine}`;
  }

  return '';
}
