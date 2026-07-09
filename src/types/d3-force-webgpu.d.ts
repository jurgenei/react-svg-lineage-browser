declare module 'd3-force-webgpu' {
  export const forceSimulationGPU: any;
  export const forceManyBody: any;
  export const forceLink: any;
  export const forceCollide: any;
  export const forceX: any;
  export const forceY: any;
  export const checkWebGPUSupport: () => Promise<boolean>;
}

