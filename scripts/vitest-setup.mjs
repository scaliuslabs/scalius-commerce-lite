// Unit tests stub `globalThis.fetch` on purpose (`vi.stubGlobal`) and expect
// host code to reach the stub. The bundled loader's egress guard otherwise
// keeps the fetch captured at module load and locks the property; this flag
// (read once when that module loads) lets it follow the stub instead. A test
// of the real behaviour deletes the flag in `vi.hoisted`.
Reflect.set(globalThis, Symbol.for("scalius.plugins.ambientHostFetch"), true);
