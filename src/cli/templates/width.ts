/**
 * Terminal display width: East Asian wide and fullwidth characters (CJK, Hangul, fullwidth forms,
 * most emoji) take two columns; combining marks take none. Enough to align tables in any script.
 */
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1faff],
  [0x20000, 0x3fffd],
];

function codePointWidth(codePoint: number, char: string): number {
  if (/\p{M}/u.test(char) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
    return 0;
  }
  return WIDE.some(([start, end]) => codePoint >= start && codePoint <= end) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0, char);
  }
  return width;
}

export function padDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
