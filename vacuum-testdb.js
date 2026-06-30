/**
 * VACUUM 脚本 — 针对 .pueblo/test.db (WAL 模式)
 * 用法: D:\Tools\node.exe vacuum-testdb.js
 * 
 * 前提: 先关闭 Pueblo 释放数据库锁
 */

const path = require('path');
const fs = require('fs');

const DB_PATH  = path.resolve(__dirname, '.pueblo', 'test.db');
const BETTER_SQLITE3 = path.resolve(__dirname, 'node_modules', 'better-sqlite3');

if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ 数据库不存在: ${DB_PATH}`);
    process.exit(1);
}

const Database = require(BETTER_SQLITE3);

function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function getFileSize(filePath) {
    try { return fs.statSync(filePath).size; } catch { return -1; }
}

function getWalSize() {
    const walPath = DB_PATH + '-wal';
    const shmPath = DB_PATH + '-shm';
    return { wal: getFileSize(walPath), shm: getFileSize(shmPath) };
}

console.log('═══════════════════════════════════════════');
console.log('  test.db — VACUUM 操作');
console.log('═══════════════════════════════════════════');

// ---- 操作前 ----
const beforeSize = getFileSize(DB_PATH);
const beforeWal  = getWalSize();
console.log(`\n📦 操作前:`);
console.log(`   test.db     = ${formatBytes(beforeSize)}`);
console.log(`   test.db-wal = ${formatBytes(beforeWal.wal)}`);
console.log(`   test.db-shm = ${formatBytes(beforeWal.shm)}`);

// ---- 连接数据库 ----
let db;
try {
    db = new Database(DB_PATH);
} catch (e) {
    console.error(`\n❌ 无法打开数据库: ${e.message}`);
    console.error('   请确认 Pueblo 已完全关闭。');
    process.exit(1);
}

try {
    // 1. 记录当前 journal_mode
    const currentMode = db.pragma('journal_mode');
    console.log(`\n📋 当前 journal_mode: ${currentMode}`);

    // 2. 将所有临时数据放在内存中（避免 C 盘写入）
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -16000'); // 16MB cache

    // 3. 切换到 DELETE 模式（VACUUM 要求）
    console.log('🔄 切换到 journal_mode = DELETE ...');
    db.pragma('journal_mode = DELETE');

    // 4. 执行 VACUUM
    console.log('⏳ 执行 VACUUM（433MB 可能需要 10-30 秒）...');
    const startTime = Date.now();
    db.exec('VACUUM');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ VACUUM 完成，耗时 ${elapsed}s`);

    // 5. 切回 WAL 模式
    console.log('🔄 恢复 journal_mode = WAL ...');
    db.pragma('journal_mode = WAL');

    console.log('✅ 一切完成。');
} catch (e) {
    console.error(`\n❌ 操作失败: ${e.message}`);
    process.exit(1);
} finally {
    if (db) db.close();
}

// ---- 操作后 ----
const afterSize = getFileSize(DB_PATH);
const afterWal  = getWalSize();
const reclaimed = beforeSize - afterSize;

console.log(`\n📦 操作后:`);
console.log(`   test.db     = ${formatBytes(afterSize)}`);
console.log(`   test.db-wal = ${formatBytes(afterWal.wal)}`);
console.log(`   test.db-shm = ${formatBytes(afterWal.shm)}`);
console.log(`\n💾 回收空间: ${formatBytes(reclaimed > 0 ? reclaimed : 0)}`);

if (reclaimed > 0) {
    const pct = ((reclaimed / beforeSize) * 100).toFixed(1);
    console.log(`   缩减比例: ${pct}%`);
}
