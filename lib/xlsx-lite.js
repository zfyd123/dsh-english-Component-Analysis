/**
 * xlsx-lite.js —— 只读取 .xlsx 第一张表的最小实现，零依赖。
 *
 * xlsx 本质是 zip 包里的几份 XML：用 node:zlib 解压，再用正则取单元格。
 * 只够读「纯文本 / 数字」的词表，不处理公式、样式、合并单元格。
 */

import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

function readZipEntries(buf) {
  // 从尾部找 End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx（找不到 zip 目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : inflateRawSync(raw);
    return data.toString("utf8");
  };
  return { names: [...entries.keys()], read };
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textOf(xml) {
  const parts = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) parts.push(m[1]);
  return unescapeXml(parts.join(""));
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 返回二维数组（行 → 列 → 字符串）；空单元格是空串 */
export async function readXlsxRows(file) {
  const zip = readZipEntries(await readFile(file));

  let shared = [];
  const sst = zip.read("xl/sharedStrings.xml");
  if (sst) {
    const items = sst.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) ?? [];
    shared = items.map((si) => textOf(si.replace(/<rPh[\s\S]*?<\/rPh>/g, "")));
  }

  const sheetName = zip.names.find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheet = sheetName ? zip.read(sheetName) : null;
  if (!sheet) throw new Error("xlsx 里没有工作表");

  const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const cells = [];
    const body = rm[1] ?? "";
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? "";
      else if (type === "inlineStr") value = textOf(inner);
      else value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      cells[ref ? colIndex(ref) : cells.length] = value;
    }
    rows.push(Array.from(cells, (c) => c ?? ""));
  }
  return rows;
}
