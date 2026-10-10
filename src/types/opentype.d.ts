// The parts of opentype.js (2.x, no bundled types) that the watermark uses.
declare module "opentype.js" {
  export interface Path {
    toPathData(decimalPlaces?: number): string;
  }
  export interface Font {
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    getAdvanceWidth(text: string, fontSize: number): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
