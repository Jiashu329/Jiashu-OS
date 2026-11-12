// Used only by the minified-renderer DOM harness. No authenticated route handler
// is executed, and the synthetic Worker has no D1, secrets or other bindings.
const emptyWorker = 'data:text/javascript,' + encodeURIComponent('export const env = Object.freeze(Object.create(null));');

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { url: emptyWorker, shortCircuit: true };
  return nextResolve(specifier, context);
}
