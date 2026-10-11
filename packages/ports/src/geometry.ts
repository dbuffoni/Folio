/**
 * Geometry primitives shared by every port.
 *
 * Coordinate convention: PDF user space — points (1/72 in), origin at the bottom-left of the page,
 * y pointing up, before the page /Rotate entry is applied. View conversion lives in @folio/core.
 */
export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
/** Axis-aligned rectangle; (x, y) is the lower-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Quadrilateral (used by text markup); points in order: top-left, top-right, bottom-left, bottom-right. */
export interface Quad {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}
/** Affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];
/** sRGB colour, components 0–255, optional alpha 0–1. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}
export type Rotation = 0 | 90 | 180 | 270;
