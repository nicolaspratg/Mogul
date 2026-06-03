// The `node-soap` package ships no TypeScript types. This ambient declaration
// models just the surface this codebase uses, so the strict `tsc` build can
// resolve it. Runtime behaviour is unchanged (we already run fine via tsx).
declare module 'node-soap' {
  // SOAP method calls are accessed dynamically (`client[`${method}Async`]`),
  // so `any` is the honest type here.
  export type Client = any;
  export function createClientAsync(
    url: string,
    options?: unknown,
  ): Promise<Client>;
}
