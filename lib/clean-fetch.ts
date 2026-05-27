// @vercel/sandbox passes `dispatcher` through to fetch on Node 26+, which
// mangles brotli-decoded ndjson responses. Strip it.
export const cleanFetch: typeof fetch = (input, init) => {
  const { dispatcher: _, ...rest } = (init ?? {}) as any;
  return fetch(input as any, rest);
};
