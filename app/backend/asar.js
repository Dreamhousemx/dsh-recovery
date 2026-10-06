"use strict";
// Minimal read-only ASAR reader.
//
// The official DeepSeek Harness ships its DSH runtime inside resources/app.asar.
// Reading that archive lets the recovery console report the installed DSH
// version and confirm the archive is still parseable, without unpacking
// 121 MB or depending on Electron's patched fs (which only exists for the
// app's own process, not for a helper that reads other installs).
//
// Layout (chromium Pickle framing, verified against both installed shells):
//   [0..4)   uint32 payload size of the size pickle (always 4)
//   [4..8)   uint32 headerSize = byte length of the header pickle that follows
//   [8..)    header pickle: [0..4) payload size, [4..8) JSON text length,
//            [8..8+len) the JSON directory header, padding to headerSize
//   [8+headerSize..) raw file data; header entry offsets are relative to it
// The JSON header maps names to either { files: {...} } (directory) or
// { size, offset } (file, offset relative to the start of file data).

const fs = require("node:fs");

const HEADER_READ_LIMIT = 64 * 1024 * 1024;

/**
 * Run synchronous filesystem work with Electron's asar support disabled.
 *
 * Inside Electron, the patched `fs` treats any path containing `.asar` as a
 * virtual directory: `fs.statSync(".../app.asar")` reports a directory and
 * `fs.readSync` returns archive members instead of the raw pickle. Reading an
 * archive therefore has to bypass the patch (`process.noAsar`), which is safe
 * here because every call below is synchronous.
 */
function withoutAsar(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = previous;
  }
}

function readHeader(file) {
  return withoutAsar(() => {
    const fd = fs.openSync(file, "r");
    try {
      const sizeBuffer = Buffer.alloc(8);
      if (fs.readSync(fd, sizeBuffer, 0, 8, 0) !== 8) throw new Error("asar 文件过短");
      const headerSize = sizeBuffer.readUInt32LE(4);
      if (headerSize === 0 || headerSize > HEADER_READ_LIMIT) throw new Error(`asar 头部大小异常: ${headerSize}`);
      const headerBuffer = Buffer.alloc(headerSize);
      const read = fs.readSync(fd, headerBuffer, 0, headerSize, 8);
      if (read !== headerSize) throw new Error("asar 头部被截断");
      const headerTextLength = headerBuffer.readUInt32LE(4);
      if (headerTextLength === 0 || headerTextLength > headerSize) {
        throw new Error(`asar 头部文本长度异常: ${headerTextLength}`);
      }
      const headerText = headerBuffer.toString("utf8", 8, 8 + headerTextLength);
      return {
        header: JSON.parse(headerText),
        dataOffset: 8 + headerSize,
      };
    } finally {
      fs.closeSync(fd);
    }
  });
}

function normalizeEntryPath(entryPath) {
  return String(entryPath).replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
}

function lookup(header, entryPath) {
  const normalized = normalizeEntryPath(entryPath);
  if (normalized === "") return { node: header, name: "" };
  const parts = normalized.split("/");
  let node = header;
  let name = "";
  for (const part of parts) {
    if (node === undefined || node.files === undefined) return undefined;
    node = node.files[part];
    name = part;
  }
  if (node === undefined) return undefined;
  return { node, name };
}

/** One-shot open: returns a handle exposing header lookup and file reads. */
function openAsar(file) {
  const { header, dataOffset } = readHeader(file);
  const fd = withoutAsar(() => fs.openSync(file, "r"));
  return {
    header,
    dataOffset,
    has(entryPath) {
      return lookup(header, entryPath) !== undefined;
    },
    /** Read an archived file as a UTF-8 string, or undefined when absent. */
    readText(entryPath) {
      const found = lookup(header, entryPath);
      if (found === undefined || found.node.offset === undefined || found.node.size === undefined) return undefined;
      const buffer = Buffer.alloc(found.node.size);
      withoutAsar(() => fs.readSync(fd, buffer, 0, found.node.size, dataOffset + Number(found.node.offset)));
      return buffer.toString("utf8");
    },
    readJson(entryPath) {
      const text = this.readText(entryPath);
      if (text === undefined) return undefined;
      try {
        return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch {
        return undefined;
      }
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/** Convenience: read one JSON file out of an asar without keeping a handle. */
function readAsarJson(file, entryPath) {
  let handle;
  try {
    handle = openAsar(file);
    return handle.readJson(entryPath);
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) handle.close();
  }
}

module.exports = { openAsar, readAsarJson, withoutAsar };
