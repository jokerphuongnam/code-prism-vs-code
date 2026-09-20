declare module "d3-force-3d" {
  export function forceCollide(radius?: number | ((node: any) => number)): any;
  export function forceRadial(radius: number | ((node: any) => number), x?: number, y?: number, z?: number): any;
}
