/**
 * store-only zip 编解码（backup.* 快照用；零外部依赖）。
 *
 * 实现最小 zip 打包/解包子集：method=0（store，不压缩）+ UTF-8 文件名 +
 * 自算 CRC32。写入路径（local header + central directory + EOCD）与读取
 * 路径（EOCD 反查 central directory → local header 定位数据）各自完整，
 * 仅供本域快照自产自读（不做通用 zip 库的替代品——含压缩项/分卷等
 * 外部 zip 不支持，读取侧显式拒绝）。
 *
 * 一切数值为 LE 写入；文件名一律 UTF-8（zip 未置 UTF-8 flag 时多数解压
 * 器按本地码页读，本域自带读取器按 UTF-8 还原，Windows 中文路径可往返）。
 */
export const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/** 读取侧单包条目数护栏（与导出条目护栏同值；防恶意大清单打爆内存）。 */
export const ZIP_MAX_ENTRIES = 20_000;

/** 打包输入条目（路径为正斜杠相对形态）。 */
export interface ZipEntryInput {
  path: string;
  data: Buffer;
}

/** 读取产物条目。 */
export interface ZipEntryOutput {
  path: string;
  data: Buffer;
  size: number;
}

/** CRC32（IEEE 802.3，表驱动；镜像 zlib crc32 语义）。 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): number {
  // 固定时间戳（0）：确定性打包（时间副作用留给 manifest.created_at）
  return 0;
}

/** 写入侧工具：把条目打包为单 zip Buffer（method=0 store）。 */
export function packStoreZip(entries: readonly ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Array<{ name: Buffer; crc: number; offset: number; size: number }> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // method = store
    header.writeUInt16LE(dosDateTime(), 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra len
    chunks.push(header, name, data);
    central.push({ name, crc, offset, size: data.length });
    offset += 30 + name.length + data.length;
  }
  const centralStart = offset;
  const centralChunks: Buffer[] = [];
  for (const entry of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8); // flags
    record.writeUInt16LE(0, 10); // method = store
    record.writeUInt16LE(dosDateTime(), 12);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.size, 20);
    record.writeUInt32LE(entry.size, 24);
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt16LE(0, 30); // extra len
    record.writeUInt16LE(0, 32); // comment len
    record.writeUInt16LE(0, 34); // disk start
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(entry.offset, 42); // local header offset
    centralChunks.push(record, entry.name);
    offset += 46 + entry.name.length;
  }
  const centralSize = offset - centralStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

class ZipCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipCodecError';
  }
}

/** 从末端定位 EOCD（comment 最大 64KiB）。 */
function locateEocd(buf: Buffer): number {
  const tail = Math.min(buf.length, 65_557);
  for (let i = buf.length - 22; i >= buf.length - tail - 22; i -= 1) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
    }
  }
  throw new ZipCodecError('zip 缺 EOCD（非本域 store-zip 产物）');
}

/** 解析 central directory 条目（偏移/名/方法元数据；count 上限护栏）。 */
function readCentral(
  buf: Buffer,
  eocdOffset: number,
  maxEntries = ZIP_MAX_ENTRIES,
): Array<{
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
}> {
  const count = buf.readUInt16LE(eocdOffset + 10);
  if (count > maxEntries) {
    throw new ZipCodecError(`zip 条目数超限（>${maxEntries}）`);
  }
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdStart = buf.readUInt32LE(eocdOffset + 16);
  const entries: Array<{
    name: string;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    localOffset: number;
  }> = [];
  let cursor = cdStart;
  const end = cdStart + cdSize;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end) throw new ZipCodecError('central directory 截断');
    if (buf.readUInt32LE(cursor) !== ZIP_CENTRAL_SIG) {
      throw new ZipCodecError('central directory 签名不匹配');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const csize = buf.readUInt32LE(cursor + 20);
    const usize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLen > end) throw new ZipCodecError('central directory 名称越界');
    entries.push({
      name: buf.toString('utf8', nameStart, nameStart + nameLen),
      method,
      crc,
      csize,
      usize,
      localOffset,
    });
    cursor = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 按 central 条目定位并读取数据（method=0 store；其余显式拒绝）。 */
function readEntryData(buf: Buffer, entry: {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
}): Buffer {
  if (entry.method !== 0) {
    throw new ZipCodecError(`zip 含压缩项不支持: ${entry.name}（method=${entry.method}）`);
  }
  if (entry.csize !== entry.usize) {
    throw new ZipCodecError(`zip 存储项尺寸不一致: ${entry.name}`);
  }
  const cursor = entry.localOffset;
  if (cursor + 30 > buf.length) throw new ZipCodecError(`zip local header 越界: ${entry.name}`);
  if (buf.readUInt32LE(cursor) !== ZIP_LOCAL_SIG) {
    throw new ZipCodecError(`zip local header 签名不匹配: ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(cursor + 26);
  const extraLen = buf.readUInt16LE(cursor + 28);
  const dataStart = cursor + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.usize;
  if (dataEnd > buf.length) throw new ZipCodecError(`zip 数据越界: ${entry.name}`);
  const data = buf.subarray(dataStart, dataEnd);
  const actual = Buffer.from(data);
  if (crc32(actual) !== entry.crc) {
    throw new ZipCodecError(`zip CRC 校验失败: ${entry.name}`);
  }
  return actual;
}

/** 解析本域 store-zip 产物 → 条目清单（含数据；条目数护栏）。 */
export function unpackStoreZip(buf: Buffer, options: { maxEntries?: number } = {}): ZipEntryOutput[] {
  const eocd = locateEocd(buf);
  const central = readCentral(buf, eocd, options.maxEntries ?? ZIP_MAX_ENTRIES);
  return central.map((entry) => {
    const data = readEntryData(buf, entry);
    return { path: entry.name, data, size: data.length };
  });
}

/** 仅清单读取（数据不整包落内存；预览用；条目数护栏）。 */
export function listStoreZip(buf: Buffer, options: { maxEntries?: number } = {}): Array<{ path: string; size: number }> {
  const eocd = locateEocd(buf);
  const central = readCentral(buf, eocd, options.maxEntries ?? ZIP_MAX_ENTRIES);
  return central.map((entry) => ({
    path: entry.name,
    size: entry.usize,
  }));
}
