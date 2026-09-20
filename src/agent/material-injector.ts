import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MAX_VISION_IMAGE_BYTES, isImagePath, probeImageFileSync } from '../tools/image-format';

/**
 * Phase3：`<workspace>/materials` 目录扫描自动注入。
 *
 * 约定：用户把待识别的图片（如试卷扫描件）放到工作区 `materials/` 目录下，
 * 每次上下文解析时扫描该目录，把**新增/变更**的图片作为 user 图片部件注入
 * （仅 vision 模型），并用 `.pueblo/material-manifest.json` 记录已注入图片的
 * 指纹（相对路径 + 大小 + mtimeMs），实现增量注入，避免每轮重复传输同一张图。
 *
 * 扫描为**非递归**（仅 `materials/` 顶层文件），保证行为可预期。
 */

export const MATERIALS_DIR_NAME = 'materials';
export const MATERIAL_MANIFEST_DIR_NAME = '.pueblo';
export const MATERIAL_MANIFEST_FILE_NAME = 'material-manifest.json';
export const MATERIAL_MANIFEST_VERSION = 1;

/** 单轮最多注入的图片数量，避免一次性把上下文/请求体撑爆。 */
export const MAX_MATERIAL_IMAGES_PER_TURN = 8;

/**
 * Upper bound of delivered-session ids kept per image fingerprint. Prevents the
 * manifest from growing without bound in long-lived workspaces; an evicted id
 * only risks one redundant re-delivery in a very old session.
 */
export const MAX_DELIVERED_SESSION_IDS = 20;

const materialManifestEntrySchema = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  /**
   * Sessions that already received this exact fingerprint. Enables per-session
   * delivery: a new session receives the image once, and later turns in the same
   * session do not re-attach it. A missing value marks a legacy entry, which is
   * treated as "not yet delivered to the current session" so the image is
   * attached once more after an upgrade.
   */
  deliveredSessionIds: z.array(z.string()).optional(),
});

type MaterialManifestEntry = z.infer<typeof materialManifestEntrySchema>;

export const materialManifestSchema = z.object({
  version: z.number().int().positive().default(MATERIAL_MANIFEST_VERSION),
  files: z.record(z.string(), materialManifestEntrySchema).default({}),
});

export type MaterialManifest = z.infer<typeof materialManifestSchema>;

export interface MaterialImageRef {
  /** 磁盘绝对路径。 */
  readonly absolutePath: string;
  /** 相对工作区根目录的路径（POSIX 分隔符），如 `materials/paper-01.png`。 */
  readonly relativePath: string;
  readonly fileName: string;
  /** 由 magic bytes 判定的真实 MIME，不信任扩展名。 */
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** 文件 mtime（毫秒），用于增量指纹比对。 */
  readonly mtimeMs: number;
}

export interface MaterialInjectionPlan {
  /** 本轮应作为 user 图片部件注入的新增/变更图片（非 vision 模型时为空）。 */
  readonly images: readonly MaterialImageRef[];
  /** 全量图片索引文本行（不依赖 vision），供模型了解目录并按需 `read`。 */
  readonly indexLines: readonly string[];
  /** `materials/` 目录是否存在（决定是否需要输出索引段）。 */
  readonly materialsDirectoryPresent: boolean;
  /** 本轮扫描到的全部合法图片数量（含已注入过的）。 */
  readonly scannedImageCount: number;
  /** 应写回的清单；null 表示无变化、无需写盘。 */
  readonly nextManifest: MaterialManifest | null;
  /** 清单文件绝对路径；工作区不可用时为 null。 */
  readonly manifestPath: string | null;
}

const EMPTY_PLAN: MaterialInjectionPlan = {
  images: [],
  indexLines: [],
  materialsDirectoryPresent: false,
  scannedImageCount: 0,
  nextManifest: null,
  manifestPath: null,
};

export function resolveMaterialManifestPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), MATERIAL_MANIFEST_DIR_NAME, MATERIAL_MANIFEST_FILE_NAME);
}

export function loadMaterialManifest(manifestPath: string): MaterialManifest {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = materialManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { version: MATERIAL_MANIFEST_VERSION, files: {} };
  } catch {
    // 文件不存在 / 非法 JSON / IO 失败：视为空清单（下次全量注入）。
    return { version: MATERIAL_MANIFEST_VERSION, files: {} };
  }
}

export function saveMaterialManifest(manifestPath: string, manifest: MaterialManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * 扫描 `<workspaceRoot>/materials` 并规划本轮注入内容。
 *
 * 纯规划：不写盘（写盘由调用方通过 `commitMaterialInjection` 显式触发），
 * 便于单测与失败回退。
 */
export function collectMaterialInjection(args: {
  readonly workspaceRoot: string | null;
  readonly supportsVision: boolean;
  readonly maxImages?: number;
  /** Current session id; enables per-session delivery when provided. */
  readonly sessionId?: string | null;
}): MaterialInjectionPlan {
  const workspaceRoot = args.workspaceRoot ? path.resolve(args.workspaceRoot) : null;
  if (!workspaceRoot) {
    return EMPTY_PLAN;
  }

  const materialsDirectory = path.join(workspaceRoot, MATERIALS_DIR_NAME);
  if (!isDirectory(materialsDirectory)) {
    return EMPTY_PLAN;
  }

  const manifestPath = resolveMaterialManifestPath(workspaceRoot);
  const previousManifest = loadMaterialManifest(manifestPath);
  const scannedImages = scanMaterialImages(materialsDirectory);
  const sessionId = args.sessionId ?? null;
  if (scannedImages.length === 0) {
    return {
      images: [],
      indexLines: [],
      materialsDirectoryPresent: true,
      scannedImageCount: 0,
      nextManifest: buildNextManifest(previousManifest, [], [], sessionId),
      manifestPath,
    };
  }

  const changedImages = scannedImages.filter((image) => {
    const fingerprint = previousManifest.files[image.relativePath];
    if (!fingerprint) {
      return true;
    }
    if (fingerprint.size !== image.sizeBytes || fingerprint.mtimeMs !== image.mtimeMs) {
      return true;
    }
    // Per-session delivery: attach once per session even when the file is unchanged.
    // Without a session id we keep the legacy global incremental behaviour.
    return sessionId !== null && !(fingerprint.deliveredSessionIds ?? []).includes(sessionId);

  });

  const maxImages = args.maxImages ?? MAX_MATERIAL_IMAGES_PER_TURN;
  const selectedImages = args.supportsVision ? changedImages.slice(0, Math.max(0, maxImages)) : [];
  const selectedPaths = new Set(selectedImages.map((image) => image.relativePath));

  const indexLines = buildMaterialIndexLines(scannedImages, selectedPaths, args.supportsVision);

  return {
    images: selectedImages,
    indexLines,
    materialsDirectoryPresent: true,
    scannedImageCount: scannedImages.length,
    nextManifest: buildNextManifest(previousManifest, selectedImages, scannedImages, sessionId),
    manifestPath,
  };
}

/** 把规划结果中的清单写盘（仅在确有变化时）。 */
export function commitMaterialInjection(plan: MaterialInjectionPlan): void {
  if (!plan.manifestPath || !plan.nextManifest) {
    return;
  }
  saveMaterialManifest(plan.manifestPath, plan.nextManifest);
}

function scanMaterialImages(materialsDirectory: string): MaterialImageRef[] {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(materialsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const images: MaterialImageRef[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isImagePath(dirent.name)) {
      continue;
    }

    const absolutePath = path.join(materialsDirectory, dirent.name);
    const probe = probeImageFileSync(absolutePath);
    if (!probe.ok) {
      // 非图片字节 / 超过单图上限 / 读取失败：跳过且不记账，后续轮次可重试。
      continue;
    }

    images.push({
      absolutePath,
      relativePath: toPosixPath(path.join(MATERIALS_DIR_NAME, dirent.name)),
      fileName: dirent.name,
      mimeType: probe.mimeType,
      sizeBytes: probe.sizeBytes,
      mtimeMs: fs.statSync(absolutePath).mtimeMs,
    });
  }

  images.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return images;
}

function buildMaterialIndexLines(
  scannedImages: readonly MaterialImageRef[],
  selectedPaths: ReadonlySet<string>,
  supportsVision: boolean,
): string[] {
  const lines = [
    `About the \`${MATERIALS_DIR_NAME}/\` directory (auto-scanned, non-recursive; only image files are listed):`,
  ];

  for (const image of scannedImages) {
    const kib = Math.max(1, Math.round(image.sizeBytes / 1024));
    const suffix = selectedPaths.has(image.relativePath) && supportsVision
      ? ' [attached as image part this turn]'
      : '';
    lines.push(`- ${image.relativePath} (${image.mimeType}, ${kib} KiB)${suffix}`);
  }

  if (supportsVision) {
    lines.push('Images already delivered in earlier turns are not re-attached; use the read tool to view them again if needed.');
  } else {
    lines.push('The current model does not support image input, so these files are not auto-attached; use the read tool to inspect a specific image.');
  }

  return lines;
}

function buildNextManifest(
  previousManifest: MaterialManifest,
  selectedImages: readonly MaterialImageRef[],
  scannedImages: readonly MaterialImageRef[] = [],
  sessionId: string | null = null,
): MaterialManifest | null {
  const validPaths = new Set(scannedImages.map((image) => image.relativePath));
  const files: Record<string, MaterialManifestEntry> = {};

  // 保留仍然存在且未被本轮选中的历史指纹（清理已删除文件）。
  for (const [relativePath, entry] of Object.entries(previousManifest.files)) {
    if (validPaths.has(relativePath)) {
      files[relativePath] = entry;
    }
  }

  // 记录本轮实际注入的图片指纹。
  for (const image of selectedImages) {
    files[image.relativePath] = buildManifestEntry(previousManifest.files[image.relativePath], image, sessionId);
  }

  const sortedFiles = sortRecord(files);
  const nextManifest: MaterialManifest = { version: MATERIAL_MANIFEST_VERSION, files: sortedFiles };
  return isSameManifest(previousManifest, nextManifest) ? null : nextManifest;
}

function buildManifestEntry(
  previous: MaterialManifestEntry | undefined,
  image: MaterialImageRef,
  sessionId: string | null,
): MaterialManifestEntry {
  const deliveredSessionIds =
    previous !== undefined && previous.size === image.sizeBytes && previous.mtimeMs === image.mtimeMs
      ? [...(previous.deliveredSessionIds ?? [])]
      : [];
  if (sessionId !== null && !deliveredSessionIds.includes(sessionId)) {
    deliveredSessionIds.push(sessionId);
  }
  const keptSessionIds = deliveredSessionIds.slice(-MAX_DELIVERED_SESSION_IDS);
  return {
    size: image.sizeBytes,
    mtimeMs: image.mtimeMs,
    ...(keptSessionIds.length > 0 ? { deliveredSessionIds: keptSessionIds } : {}),
  };
}

function sortRecord(record: Record<string, MaterialManifestEntry>): Record<string, MaterialManifestEntry> {
  const sorted: Record<string, { size: number; mtimeMs: number }> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = record[key];
  }
  return sorted;
}

function isSameManifest(a: MaterialManifest, b: MaterialManifest): boolean {
  return a.version === b.version && JSON.stringify(a.files) === JSON.stringify(b.files);
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}
