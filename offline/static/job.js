const Job = (() => {
  function coalesce(fn) {
    let running = false;
    let again = false;
    return async function schedule() {
      if (running) { again = true; return; }
      running = true;
      try {
        do { again = false; await fn(); } while (again);
      } finally { running = false; }
    };
  }

  function debounce(fn, wait) {
    let timer = null;
    let running = false;
    let again = false;

    async function run() {
      if (running) { again = true; return; }
      running = true;
      again = false;
      try {
        await fn();
      } finally {
        running = false;
        if (again) { clearTimeout(timer); timer = setTimeout(run, wait); }
      }
    }

    return function schedule() {
      again = true;
      clearTimeout(timer);
      timer = setTimeout(run, wait);
    };
  }

  return { coalesce, debounce };
})();
