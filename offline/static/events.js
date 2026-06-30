const Events = (() => {
  const target = new EventTarget();

  function on(type, fn) {
    target.addEventListener(type, (event) => fn(event.detail || {}));
  }

  function emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
  }

  return { on, emit };
})();
