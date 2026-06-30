const Sync = (() => {
  const syncers = {};
  const requested = new Set();

  const schedule = Job.debounce(async () => {
    if (!navigator.onLine) return;

    const domains = requested.has("all") ? Object.keys(syncers) : [...requested];
    requested.clear();

    for (const domain of domains) {
      const syncer = syncers[domain];
      if (!syncer) continue;
      try {
        const changed = await syncer.run();
        Events.emit(syncer.synced, { changed });
        if (changed) Events.emit(syncer.changed, { reason: "server-reconcile" });
      } catch (e) { /* isolate domains: a failed one is skipped this pass, retried on the next trigger */ }
    }
  }, 750);

  function register(domain, syncer) {
    syncers[domain] = syncer;
  }

  function request(domain) {
    if (!navigator.onLine) return;
    requested.add(domain);
    schedule();
  }

  return { register, request };
})();
