/**
 * 纯词法路径解析（sandbox.py 中 pathlib 判定的零 IO 镜像面）。
 *
 * pathlib 的 Path.resolve/relative_to 按宿主平台语义做绝对化归一与越界
 * 判定；其中 symlink 跟随属 fs 动作（需 lstat/readlink），由 FileSandbox
 * 的 realpath seam 承担。本模块只做纯词法：/ 与 \ 同权（Windows 惯用 \），
 * 卷（盘符/UNC）与 POSIX 根各自保持，'.' 段与重复分隔符折叠，'..' 段逐层
 * 弹出且不允许越过卷根（越根即停留在根，路径越界由 FileSandbox 按前缀
 * 判定拒绝，与 Path.relative_to 抛 ValueError 同语义）。
 *
 * core 零 IO：不查询宿主平台，路径风格按内容判定（盘符/UNC 开头 =
 * Windows，单个 '/' 开头 = POSIX）；Windows 卷与段比较不分大小写、POSIX
 * 区分大小写——对齐 pathlib 随宿主平台的 relative_to 语义。
 */

const SEP_RE = /[\\/]+/;
const WIN_DRIVE_RE = /^([A-Za-z]:)[\\/]/;
const UNC_RE = /^[\\/]{2,}([^\\/]+)[\\/]([^\\/]+)/;

/** 解析出的路径骨架：卷前缀（'' = 无卷）+ 卷后剩余串。 */
interface Parts {
  vol: string;
  rest: string;
}

/** 卷前缀提取：UNC（\\server\share）/Windows 盘符（C:\）/无卷三种形态。 */
function split_volume(path: string): Parts {
  const unc = UNC_RE.exec(path);
  if (unc !== null) {
    return {
      vol: `\\\\${unc[1]}\\${unc[2]}`,
      rest: path.slice(unc[0]!.length),
    };
  }
  const drive = WIN_DRIVE_RE.exec(path);
  if (drive !== null) {
    return { vol: drive[1]!, rest: path.slice(drive[0]!.length) };
  }
  return { vol: '', rest: path };
}

/** 是否绝对路径形态：盘符+分隔 / UNC / 单个分隔符开头。 */
export function is_absolute(path: string): boolean {
  if (UNC_RE.test(path) || WIN_DRIVE_RE.test(path)) return true;
  return path.startsWith('/') || path.startsWith('\\');
}

/** 剩余串按分隔符切段：折叠空段与 '.'，'..' 保留（供归一时弹出）。 */
function segments(rest: string): string[] {
  return rest.split(SEP_RE).filter((s) => s !== '' && s !== '.');
}

/** 词法归一：'.' 折叠、'..' 逐层弹出且不允许越过卷根。 */
function merge_parts(baseRest: string, tailRest: string): string[] {
  const out: string[] = [];
  for (const seg of `${baseRest}/${tailRest}`.split(SEP_RE)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
    } else {
      out.push(seg);
    }
  }
  return out;
}

/** 按卷风格渲染绝对路径：Windows 卷用 '\'，POSIX 根 '/'；空段 = 卷根。 */
function render(vol: string, segs: readonly string[]): string {
  if (vol !== '') {
    if (segs.length === 0) return vol.length === 2 ? `${vol}\\` : vol;
    return `${vol}\\${segs.join('\\')}`;
  }
  return `/${segs.join('/')}`;
}

/**
 * 词法绝对化（镜像 Path.resolve 的非 symlink 部分）。
 *
 * base 须为绝对路径。target 自带卷（盘符/UNC）= 整体替换基准（跨盘绝对
 * 路径语义）；target 仅以分隔符开头 = 锚到基准卷根（C:\base + /x → C:\x）；
 * 其余相对路径在 base 下拼接。越根 '..' 停留在卷根（C:\.. = C:\）。
 */
export function lexical_abs(base: string, target: string): string {
  const b = split_volume(base);
  const t = split_volume(target);
  let vol = b.vol;
  let parts: string[];
  if (t.vol !== '') {
    vol = t.vol;
    parts = merge_parts('', t.rest);
  } else if (is_absolute(target)) {
    parts = merge_parts('', t.rest);
  } else {
    parts = merge_parts(b.rest, t.rest);
  }
  return render(vol, parts);
}

/** 前缀包含判定（Path.relative_to 不抛错的镜像）：root 是 candidate 的前缀。
 *  Windows 卷/段比较不分大小写，POSIX 区分大小写。 */
export function path_under(root: string, candidate: string): boolean {
  if (!is_absolute(root) || !is_absolute(candidate)) return false;
  const r = split_volume(root);
  const c = split_volume(candidate);
  const win = r.vol !== '' || c.vol !== '';
  if (r.vol.toLowerCase() !== c.vol.toLowerCase()) return false;
  const rSegs = segments(r.rest);
  const cSegs = segments(c.rest);
  if (rSegs.length > cSegs.length) return false;
  const eq = win
    ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string) => a === b;
  for (let i = 0; i < rSegs.length; i += 1) {
    if (!eq(rSegs[i] ?? '', cSegs[i] ?? '')) return false;
  }
  return true;
}
