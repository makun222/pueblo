import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  documentAttachmentAssetSchema,
  spreadsheetAttachmentAssetSchema,
  type DocumentAttachmentAsset,
  type DocumentAttachmentChunk,
  type InputAttachmentManifest,
  type SpreadsheetAttachmentAsset,
  type SpreadsheetAttachmentCellValue,
  type SpreadsheetAttachmentRow,
  type SpreadsheetAttachmentSheet,
} from '../../shared/schema';

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set(['.txt', '.docx', '.xls', '.xlsx']);
const INLINE_JSON_CHAR_LIMIT = 16_000;
const LARGE_DOCUMENT_CHUNK_LIMIT = 24;
const LARGE_SPREADSHEET_CELL_LIMIT = 400;
const DOCUMENT_CHUNK_CHAR_LIMIT = 1_200;

export const ATTACHMENT_FILE_DIALOG_FILTERS = [
  {
    name: 'Supported files',
    extensions: ['txt', 'docx', 'xls', 'xlsx'],
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

function resolveWorkspaceAttachmentRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.pueblo-ws');
}