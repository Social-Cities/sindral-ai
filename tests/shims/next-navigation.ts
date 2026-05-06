export const redirect = (path: string): never => {
  throw new Error(`__REDIRECT__:${path}`);
};
