import fs from 'node:fs/promises';
import path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import * as XLSX from 'xlsx';
import {
  documentAttachmentAssetSchema,
  spreadsheetAttachmentAssetSchema,
  type DocumentAttachmentAsset,
  type SpreadsheetAttachmentAsset,
  type SpreadsheetAttachmentCellValue,
} from '../shared/schema';

export interface AttachmentAssetExportResult {
  readonly assetPath: string;
  readonly exportedPath: string;
  readonly sourceFileName: string;
  readonly kind: 'document' | 'spreadsheet';
}

export interface AttachmentAssetInspection {
  readonly sourcePath: string;
  readonly sourceFileName: string;
  readonly kind: 'document' | 'spreadsheet';
  readonly previewContent: string;
}

export async function maybeExportAttachmentAssetFromContent(args: {
  readonly assetPath: string;
  readonly content: string;
}): Promise<AttachmentAssetExportResult | null> {
  const parsed = parseAttachmentAsset(args.content);
  if (!parsed) {
    return null;
  }

  if (parsed.kind === 'document') {
    await exportDocumentAsset(parsed);
  } else {
    await exportSpreadsheetAsset(parsed);
  }

  return {
    assetPath: args.assetPath,
    exportedPath: parsed.source.originalPath,
    sourceFileName: parsed.source.fileName,
    kind: parsed.kind,
  };
}

export function inspectAttachmentAssetContent(content: string): AttachmentAssetInspection | null {
  const parsed = parseAttachmentAsset(content);
  if (!parsed) {
    return null;
  }

  return {
    sourcePath: parsed.source.originalPath,
    sourceFileName: parsed.source.fileName,
    kind: parsed.kind,
    previewContent: parsed.kind === 'document'
      ? buildDocumentPreview(parsed)
      : buildSpreadsheetPreview(parsed),
  };
}

function parseAttachmentAsset(content: string): DocumentAttachmentAsset | SpreadsheetAttachmentAsset | null {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }

  const documentResult = documentAttachmentAssetSchema.safeParse(parsedJson);
  if (documentResult.success) {
    return documentResult.data;
  }

  const spreadsheetResult = spreadsheetAttachmentAssetSchema.safeParse(parsedJson);
  if (spreadsheetResult.success) {
    return spreadsheetResult.data;
  }

  return null;
}

async function exportDocumentAsset(asset: DocumentAttachmentAsset): Promise<void> {
  if (path.extname(asset.source.originalPath).toLowerCase() !== '.docx') {
    throw new Error(`Document attachment export only supports .docx targets, received ${asset.source.originalPath}`);
  }

  const paragraphs = asset.content.chunks.flatMap((chunk) => {
    const blocks = chunk.text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((block) => block.trim());
    const filteredBlocks = blocks.filter((block) => block.length > 0);

    if (filteredBlocks.length === 0) {
      return [new Paragraph('')];
    }

    return filteredBlocks.map((block) => new Paragraph({
      text: block,
    }));
  });

  const doc = new Document({
    sections: [{
      children: paragraphs.length > 0 ? paragraphs : [new Paragraph('')],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  await fs.mkdir(path.dirname(asset.source.originalPath), { recursive: true });
  await fs.writeFile(asset.source.originalPath, buffer);
}

async function exportSpreadsheetAsset(asset: SpreadsheetAttachmentAsset): Promise<void> {
  const extension = path.extname(asset.source.originalPath).toLowerCase();
  if (extension !== '.xlsx' && extension !== '.xls') {
    throw new Error(`Spreadsheet attachment export only supports .xlsx or .xls targets, received ${asset.source.originalPath}`);
  }

  const workbook = XLSX.utils.book_new();

  for (const sheet of asset.content.sheets) {
    const worksheet: XLSX.WorkSheet = {};
    let minRow = Number.POSITIVE_INFINITY;
    let minColumn = Number.POSITIVE_INFINITY;
    let maxRow = 0;
    let maxColumn = 0;

    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const decoded = XLSX.utils.decode_cell(cell.address);
        worksheet[cell.address] = {
          v: cell.value,
          t: resolveSpreadsheetCellType(cell.value),
        };
        minRow = Math.min(minRow, decoded.r);
        minColumn = Math.min(minColumn, decoded.c);
        maxRow = Math.max(maxRow, decoded.r);
        maxColumn = Math.max(maxColumn, decoded.c);
      }
    }

    if (Number.isFinite(minRow) && Number.isFinite(minColumn)) {
      worksheet['!ref'] = XLSX.utils.encode_range({
        s: { r: minRow, c: minColumn },
        e: { r: maxRow, c: maxColumn },
      });
    } else {
      worksheet['!ref'] = 'A1';
    }

    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31) || 'Sheet1');
  }

  await fs.mkdir(path.dirname(asset.source.originalPath), { recursive: true });
  XLSX.writeFile(workbook, asset.source.originalPath, {
    bookType: extension === '.xls' ? 'xls' : 'xlsx',
  });
}

function resolveSpreadsheetCellType(value: SpreadsheetAttachmentCellValue): 's' | 'n' | 'b' | 'z' {
  if (typeof value === 'number') {
    return 'n';
  }

  if (typeof value === 'boolean') {
    return 'b';
  }

  if (value === null) {
    return 'z';
  }

  return 's';
}

function buildDocumentPreview(asset: DocumentAttachmentAsset): string {
  const text = asset.content.chunks
    .map((chunk) => chunk.text.trim())
    .filter((chunk) => chunk.length > 0)
    .join('\n\n');

  return [
    `Document export: ${asset.source.fileName}`,
    truncatePreviewContent(text.length > 0 ? text : '[Empty document]'),
  ].join('\n');
}

function buildSpreadsheetPreview(asset: SpreadsheetAttachmentAsset): string {
  const lines: string[] = [];

  for (const sheet of asset.content.sheets) {
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        lines.push(`${sheet.name}!${cell.address} = ${formatSpreadsheetCellValue(cell.value)}`);
        if (lines.length >= 12) {
          return [
            `Spreadsheet export: ${asset.source.fileName}`,
            ...lines,
            '... (more cells omitted)',
          ].join('\n');
        }
      }
    }
  }

  return [
    `Spreadsheet export: ${asset.source.fileName}`,
    ...(lines.length > 0 ? lines : ['[Empty spreadsheet]']),
  ].join('\n');
}

function formatSpreadsheetCellValue(value: SpreadsheetAttachmentCellValue): string {
  if (value === null) {
    return 'null';
  }

  return String(value);
}

function truncatePreviewContent(value: string): string {
  return value.length <= 1200 ? value : `${value.slice(0, 1197)}...`;
}