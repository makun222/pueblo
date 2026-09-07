import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  documentAttachmentAssetSchema,
  imageAttachmentAssetSchema,
  spreadsheetAttachmentAssetSchema,
  type DocumentAttachmentAsset,
  type DocumentAttachmentChunk,
  type ImageAttachmentAsset,
  type InputAttachmentManifest,
  type SpreadsheetAttachmentAsset,
  type SpreadsheetAttachmentCellValue,
  type SpreadsheetAttachmentRow,
  type SpreadsheetAttachmentSheet,
} from '../../shared/schema';

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set(['.txt', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const INLINE_JSON_CHAR_LIMIT = 16_000;
const LARGE_DOCUMENT_CHUNK_LIMIT = 24;
const LARGE_SPREADSHEET_CELL_LIMIT = 400;
const DOCUMENT_CHUNK_CHAR_LIMIT = 1_200;

export const ATTACHMENT_FILE_DIALOG_FILTERS = [
  {
    name: 'Supported files',
    extensions: ['txt', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'gif', 'webp'],
  },
];

export async function ingestInputFiles(args: {
  readonly filePaths: string[];
  readonly workspaceRoot: string;
  readonly sessionId: string | null;
}): Promise<InputAttachmentManifest[]> {
  const manifests: InputAttachmentManifest[] = [];

  for (const filePath of args.filePaths) {
    manifests.push(await ingestSingleInputFile({
      filePath,
      workspaceRoot: args.workspaceRoot,
      sessionId: args.sessionId,
    }));
  }

  return manifests;
}

async function ingestSingleInputFile(args: {
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly sessionId: string | null;
}): Promise<InputAttachmentManifest> {
  const absolutePath = path.resolve(args.filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const fileName = path.basename(absolutePath);

  if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported attachment type: ${extension || fileName}`);
  }

  const attachmentId = createAttachmentId(fileName);
  const createdAt = new Date().toISOString();
  const attachmentDir = path.join(resolveWorkspaceAttachmentRoot(args.workspaceRoot), 'attachments', args.sessionId ?? 'detached');
  await fs.mkdir(attachmentDir, { recursive: true });
  const jsonPath = path.join(attachmentDir, `${attachmentId}.json`);

  const assetBase = {
    jsonPath,
    createdAt,
    sizeBytes: 0,
    editable: true,
    schemaVersion: 1,
  };
  const source = {
    fileName,
    originalPath: absolutePath,
    extension,
    mimeType: resolveMimeType(extension),
  };

  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    const buffer = await fs.readFile(absolutePath);
    const mimeType = detectImageMimeType(buffer);
    const imageSource = { ...source, mimeType };
    const imageCopyPath = path.join(path.dirname(jsonPath), `${attachmentId}${extension}`);
    await fs.writeFile(imageCopyPath, buffer);
    const summary = {
      isLarge: false,
      chunkCount: null,
      sheetCount: null,
      rowCount: null,
      cellCount: null,
      previewText: formatImagePreviewText(fileName, mimeType, buffer.byteLength),
    };
    const imageAsset: ImageAttachmentAsset = imageAttachmentAssetSchema.parse({
      attachmentId,
      kind: 'image',
      source: imageSource,
      asset: {
        ...assetBase,
        filePath: imageCopyPath,
        editable: false,
      },
      summary,
    });
    const payload = JSON.stringify(imageAsset, null, 2);
    await fs.writeFile(jsonPath, payload, 'utf8');
    const stat = await fs.stat(jsonPath);

    return {
      attachmentId,
      kind: 'image',
      source: imageSource,
      asset: {
        ...assetBase,
        filePath: imageCopyPath,
        editable: false,
        sizeBytes: stat.size,
      },
      summary,
      inlineJsonExcerpt: payload.length <= INLINE_JSON_CHAR_LIMIT ? payload : null,
    };
  }

  if (extension === '.txt' || extension === '.docx') {
    const text = extension === '.txt'
      ? await fs.readFile(absolutePath, 'utf8')
      : (await mammoth.extractRawText({ path: absolutePath })).value;
    const chunks = createDocumentChunks(text);
    const summary = {
      isLarge: chunks.length > LARGE_DOCUMENT_CHUNK_LIMIT,
      chunkCount: chunks.length,
      sheetCount: null,
      rowCount: null,
      cellCount: null,
      previewText: summarizeText(text),
    };

    const documentAsset: DocumentAttachmentAsset = documentAttachmentAssetSchema.parse({
      attachmentId,
      kind: 'document',
      source,
      asset: assetBase,
      summary,
      content: {
        chunks,
      },
    });
    const payload = JSON.stringify(documentAsset, null, 2);
    await fs.writeFile(jsonPath, payload, 'utf8');
    const stat = await fs.stat(jsonPath);

    return {
      attachmentId,
      kind: 'document',
      source,
      asset: {
        ...assetBase,
        sizeBytes: stat.size,
      },
      summary,
      inlineJsonExcerpt: payload.length <= INLINE_JSON_CHAR_LIMIT ? payload : null,
    };
  }

  const workbook = XLSX.readFile(absolutePath, {
    cellDates: false,
    dense: false,
  });
  const sheets = workbook.SheetNames.map((sheetName) => createSpreadsheetSheet(sheetName, workbook.Sheets[sheetName]));
  const rowCount = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  const cellCount = sheets.reduce((sum, sheet) => sum + sheet.rows.reduce((rowSum, row) => rowSum + row.cells.length, 0), 0);
  const summary = {
    isLarge: cellCount > LARGE_SPREADSHEET_CELL_LIMIT,
    chunkCount: null,
    sheetCount: sheets.length,
    rowCount,
    cellCount,
    previewText: summarizeSpreadsheet(sheets),
  };
  const spreadsheetAsset: SpreadsheetAttachmentAsset = spreadsheetAttachmentAssetSchema.parse({
    attachmentId,
    kind: 'spreadsheet',
    source,
    asset: assetBase,
    summary,
    content: {
      sheets,
    },
  });
  const payload = JSON.stringify(spreadsheetAsset, null, 2);
  await fs.writeFile(jsonPath, payload, 'utf8');
  const stat = await fs.stat(jsonPath);

  return {
    attachmentId,
    kind: 'spreadsheet',
    source,
    asset: {
      ...assetBase,
      sizeBytes: stat.size,
    },
    summary,
    inlineJsonExcerpt: payload.length <= INLINE_JSON_CHAR_LIMIT ? payload : null,
  };
}

function createAttachmentId(fileName: string): string {
  const slug = fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'attachment';

  return `${slug}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function createDocumentChunks(text: string): DocumentAttachmentChunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [{ index: 0, text: '', heading: null }];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const chunks: DocumentAttachmentChunk[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current.length + paragraph.length + 2) <= DOCUMENT_CHUNK_CHAR_LIMIT) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }

    chunks.push({ index: chunks.length, text: current, heading: null });
    current = paragraph;
  }

  if (current) {
    chunks.push({ index: chunks.length, text: current, heading: null });
  }

  return chunks;
}

function createSpreadsheetSheet(sheetName: string, worksheet: XLSX.WorkSheet | undefined): SpreadsheetAttachmentSheet {
  if (!worksheet || !worksheet['!ref']) {
    return {
      name: sheetName,
      rows: [],
    };
  }

  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const rows: SpreadsheetAttachmentRow[] = [];

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const cells = [] as SpreadsheetAttachmentRow['cells'];

    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex });
      const cell = worksheet[address];
      if (!cell) {
        continue;
      }

      cells.push({
        column: XLSX.utils.encode_col(columnIndex),
        address,
        value: normalizeSpreadsheetCellValue(cell.v),
      });
    }

    if (cells.length > 0) {
      rows.push({
        rowIndex: rowIndex + 1,
        cells,
      });
    }
  }

  return {
    name: sheetName,
    rows,
  };
}

function normalizeSpreadsheetCellValue(value: unknown): SpreadsheetAttachmentCellValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value === null || value === undefined ? null : String(value);
}

function summarizeText(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function summarizeSpreadsheet(sheets: SpreadsheetAttachmentSheet[]): string | null {
  const firstSheet = sheets[0];
  if (!firstSheet) {
    return null;
  }

  const firstRow = firstSheet.rows[0];
  if (!firstRow) {
    return `${firstSheet.name} is empty.`;
  }

  const previewValues = firstRow.cells
    .slice(0, 4)
    .map((cell) => `${cell.address}=${cell.value === null ? 'null' : String(cell.value)}`);

  return `${firstSheet.name}: ${previewValues.join(', ')}`;
}

function resolveMimeType(extension: string): string {
  switch (extension) {
    case '.txt':
      return 'text/plain';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 基于 magic bytes 判定图片真实格式（JPEG/PNG/GIF/WebP）并返回对应 MIME。
 * 扩展名门禁之外的最后一层防线：内容与声称的图片格式不符时直接抛错，
 * 拒绝把伪装扩展名的非图片文件送入 vision 请求。
 */
function detectImageMimeType(buffer: Buffer): string {
  const head = buffer.subarray(0, 12);

  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'image/png';
  }

  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }

  if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return 'image/gif';
  }

  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  throw new Error(
    'Unsupported image format: content does not match PNG/JPEG/GIF/WebP magic bytes (extension gate passed but file is not a supported image).',
  );
}

function formatImagePreviewText(fileName: string, mimeType: string, sizeBytes: number): string {
  const kib = Math.max(1, Math.round(sizeBytes / 1024));
  return `image attachment: ${fileName} (${mimeType}, ${kib} KiB, delivered to the vision model as an image part)`;
}

function resolveWorkspaceAttachmentRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.pueblo-ws');
}