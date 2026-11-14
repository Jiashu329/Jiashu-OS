/** Runs only in the extension's isolated world on an owned Douban collection tab. */
(() => {
  if (globalThis.JiashuDoubanCollector) return;
  if (typeof globalThis.JiashuDoubanCollectorFactory !== 'function') throw new Error('Collector unavailable');
  globalThis.JiashuDoubanCollector = globalThis.JiashuDoubanCollectorFactory();
})();
