"use strict";
// Minimal, dependency-free asar reader/writer.
//
// The restart menu button patch must keep every entry's `offset` unchanged:
// the running application keeps the header it read at startup and lazily reads
// files (web client chunks, plugins) with the offsets from that snapshot. A
// rewrite that grows an entry would shift every later entry and the live window
// would start reading misaligned data. So this library only ever rewrites an
// entry in place, with a byte length identical to the header's `size`.

const crypto = require("node:crypto");
const fs = require("node:fs");

/** Reads the pickle header of an asar archive. */
function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  if (head.readUInt32LE(0) !== 4) throw new Error("asar 头部格式无法识别（pickle 版本不是 4）");
  const headerBufSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  if (!(jsonLen > 0) || jsonLen > headerBufSize) {
    throw new Error(`asar 头部长度异常（jsonLen=${jsonLen}, headerBufSize=${headerBufSize}）`);
  }
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  let json;
  try {
    json = JSON.parse(jsonBuf.toString("utf8"));
  } catch (error) {
    throw new Error(`asar 头部 JSON 解析失败：${error.message}`);
  }
  return { headerBufSize, jsonLen, dataOffset: 8 + headerBufSize, jsonBuf, json };
}

/** Resolves a slash separated path such as "lib/main.js" inside the header tree. */
function entryAt(json, entryPath) {
  let node = json;
  for (const part of entryPath.split("/")) {
    node = node && node.files ? node.files[part] : undefined;
    if (node === undefined) throw new Error(`asar 中找不到 ${entryPath}`);
  }
  if (typeof node.size !== "number" || node.offset === undefined) {
    throw new Error(`asar 中 ${entryPath} 不是文件条目`);
  }
  return node;
}

/** Reads one entry's bytes plus its absolute position. */
function readEntry(fd, header, entryPath) {
  const entry = entryAt(header.json, entryPath);
  if (entry.unpacked === true) throw new Error(`${entryPath} 被标记为 unpacked，本工具不支持`);
  const start = header.dataOffset + Number(entry.offset);
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, start);
  return { entry, start, buf };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Flattens the header into a list of files. */
function walkFiles(json, prefix = "", out = []) {
  for (const [name, node] of Object.entries(json.files ?? {})) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (node.files !== undefined) walkFiles(node, path, out);
    else out.push({ path, size: node.size, offset: Number(node.offset), unpacked: node.unpacked === true });
  }
  return out;
}

/**
 * Rewrites one entry in place.
 *
 * @param {number} fd - writable descriptor of the archive.
 * @param {object} header - result of readHeader for the same descriptor.
 * @param {string} entryPath - entry to replace.
 * @param {Buffer} next - replacement bytes; length must equal the entry size.
 * @returns {{ previousHash: string|null, hash: string, start: number }}
 */
function writeEntry(fd, header, entryPath, next) {
  const { entry, start, buf } = readEntry(fd, header, entryPath);
  if (next.length !== entry.size) {
    throw new Error(`${entryPath} 新内容 ${next.length} 字节，与头部 size ${entry.size} 不一致（禁止改变偏移）`);
  }
  fs.writeSync(fd, next, 0, next.length, start);
  const previousHash = entry.integrity && entry.integrity.hash ? entry.integrity.hash : null;
  const hash = sha256(next);
  let hits = 0;
  if (previousHash !== null) {
    const from = Buffer.from(previousHash, "utf8");
    const to = Buffer.from(hash, "utf8");
    if (from.length === to.length) {
      let pos = header.jsonBuf.indexOf(from);
      while (pos !== -1) {
        fs.writeSync(fd, to, 0, to.length, 16 + pos);
        hits += 1;
        pos = header.jsonBuf.indexOf(from, pos + 1);
      }
      if (hits > 0) header.jsonBuf.set(Buffer.from(hash, "utf8"), header.jsonBuf.indexOf(previousHash));
    }
  }
  return { previousHash, hash, start, hashHits: hits, previous: buf };
}

/** Opens an archive for writing; returns the error instead of throwing. */
function openWritable(archivePath) {
  try {
    return { fd: fs.openSync(archivePath, "r+") };
  } catch (error) {
    return { error };
  }
}

module.exports = { entryAt, openWritable, readEntry, readHeader, sha256, walkFiles, writeEntry };
