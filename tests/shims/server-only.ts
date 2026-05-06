// `server-only` throws when imported into a client bundle. Tests run in Node
// so the import is benign — this shim short-circuits the runtime check.
export {};
