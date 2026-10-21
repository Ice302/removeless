// Builds the thin-line sliders from `.slider[data-key]` placeholders.
const FMT = {
  pct: (v) => `${Math.round(v)}%`,
  signed: (v) => (v > 0 ? `+${v}` : `${v}`) + (v === 0 ? '' : ' %'),
  db: (v) => (v >= 60 ? 'Full' : `−${v} dB`),
  hz: (v) => `${v} Hz`,
  feather: (v) => `${((v / 100) * 6).toFixed(1)} px`,
  span: null, // provided by caller
};

export function buildSliders(root, store, { onInput, onCommit, formatters = {}, defaults = {} }) {
  const fmts = { ...FMT, ...formatters };
  const rows = [];
  root.querySelectorAll('.slider[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const id = `sl-${key}`;
    el.innerHTML = `
      <div class="s-top"><label for="${id}">${el.dataset.label}</label><span class="s-val" title="Double-click to reset"></span></div>
      <input id="${id}" class="line" type="range" min="${el.dataset.min}" max="${el.dataset.max}" step="1" />`;
    const input = el.querySelector('input');
    const val = el.querySelector('.s-val');
    const fmt = fmts[el.dataset.fmt] || ((v) => String(v));
    const def = defaults[key];
    const sync = () => {
      const v = store.params[key];
      input.value = v;
      val.textContent = fmt(Number(v));
      el.classList.toggle('is-modified', def !== undefined && Number(v) !== Number(def));
      input.setAttribute('aria-valuetext', val.textContent);
    };
    input.addEventListener('input', () => { onInput(key, Number(input.value)); val.textContent = fmt(Number(input.value)); });
    input.addEventListener('change', () => onCommit(key));
    // Double-click the readout (or the track) to restore the default.
    const reset = () => { if (def !== undefined) { onInput(key, def); onCommit(key); sync(); } };
    val.addEventListener('dblclick', reset);
    input.addEventListener('dblclick', reset);
    rows.push({ key, sync, el });
    sync();
  });
  return { syncAll: () => rows.forEach((r) => r.sync()), rows };
}
