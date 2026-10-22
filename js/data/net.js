// Network helpers: every request gets a deadline, so a slow or overloaded
// public server produces a clear error instead of an endless spinner.

/** Seconds allowed per kind of request. Tests may scale these down. */
export const TIMEOUTS = {
  search: 12,
  api: 12,
  tile: 15,
  overpass: 30,
  overpassHedge: 6, // start another mirror each time this passes in silence
  terrainTile: 20,
};

export function timeoutMs(kind) {
  const scale = globalThis.__FALL_LINE_TIMEOUT_SCALE || 1;
  return TIMEOUTS[kind] * 1000 * scale;
}

export class TimeoutError extends Error {
  constructor(host, seconds) {
    super(`${host} didn't respond within ${Math.round(seconds)} s`);
    this.name = 'TimeoutError';
  }
}

/** An AbortSignal that fires when `parent` aborts or after `ms`. */
export function deadline(parent, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const onAbort = () => ctl.abort(parent.reason);
  if (parent) {
    if (parent.aborted) ctl.abort(parent.reason);
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    abort: () => ctl.abort(),
    done: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * fetch() with a deadline. Throws TimeoutError when the server is too slow,
 * AbortError when the caller cancelled, and a descriptive Error for HTTP
 * failures. `parse` ('json' | 'arrayBuffer' | 'blob' | 'response') reads the
 * body inside the deadline too.
 */
export async function fetchWithTimeout(url, { signal, kind = 'api', parse = 'json', ...init } = {}) {
  const ms = timeoutMs(kind);
  const host = new URL(url).host;
  const d = deadline(signal, ms);
  try {
    const res = await fetch(url, { ...init, signal: d.signal });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText || 'error'} from ${host}`);
      err.status = res.status;
      throw err;
    }
    if (parse === 'response') return res;
    return await res[parse]();
  } catch (err) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (d.signal.aborted) throw new TimeoutError(host, ms / 1000);
    if (err.name === 'TypeError') throw new Error(`Couldn't reach ${host} (network or CORS error)`);
    throw err;
  } finally {
    d.done();
  }
}
