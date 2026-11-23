// Technische Indikatoren – reine Funktionen auf Arrays von Schlusskursen.
const Ind = {
  sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  },

  ema(arr, n) {
    const out = new Array(arr.length).fill(null);
    if (arr.length < n) return out;
    const k = 2 / (n + 1);
    let prev = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    out[n - 1] = prev;
    for (let i = n; i < arr.length; i++) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  },

  // RSI nach Wilder
  rsi(arr, n = 14) {
    const out = new Array(arr.length).fill(null);
    if (arr.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = arr[i] - arr[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  },

  macd(arr, fast = 12, slow = 26, signal = 9) {
    const ef = Ind.ema(arr, fast), es = Ind.ema(arr, slow);
    const line = arr.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const start = line.findIndex((v) => v != null);
    const sig = new Array(arr.length).fill(null);
    if (start >= 0) {
      const e = Ind.ema(line.slice(start), signal);
      e.forEach((v, j) => (sig[start + j] = v));
    }
    const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
    return { line, signal: sig, hist };
  },

  bollinger(arr, n = 20, mult = 2) {
    const mid = Ind.sma(arr, n);
    const upper = [], lower = [];
    for (let i = 0; i < arr.length; i++) {
      if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (arr[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      upper.push(mid[i] + mult * sd);
      lower.push(mid[i] - mult * sd);
    }
    return { mid, upper, lower };
  },
};
