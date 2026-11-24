/* Utilidades compartilhadas do Assinador Vaz (web) */
const AV = (() => {
  const $ = s => document.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const digits = s => String(s || '').replace(/\D/g, '');
  const fmtCpf = s => { const d = digits(s).padStart(11, '0'); return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`; };
  const maskCpf = s => { const d = digits(s); return d.length === 11 ? `${d.slice(0, 3)}.•••.•••-${d.slice(9)}` : ''; };
  function cpfOk(s) {
    const d = digits(s); if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    for (const n of [9, 10]) { let t = 0; for (let i = 0; i < n; i++) t += +d[i] * (n + 1 - i); if ((t * 10) % 11 % 10 !== +d[n]) return false; }
    return true;
  }
  const cpfInput = inp => inp.addEventListener('input', () => { const d = digits(inp.value).slice(0, 11); inp.value = d.length > 9 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d.length > 6 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}` : d.length > 3 ? `${d.slice(0, 3)}.${d.slice(3)}` : d; });
  const fmtWhen = iso => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '') + ' (Brasília)';
  const rid = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  async function sha(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 8190) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8190)); return btoa(s); }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  const b64u = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

  /* Pacote cifrado: IV(12) || AES-256-GCM(JSON). A chave só existe no link (#id.chave), nunca no servidor. */
  async function seal(obj) {
    const key = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return { bin: out, key: b64u(key) };
  }
  async function open(bin, keyStr) {
    const k = await crypto.subtle.importKey('raw', unb64u(keyStr), 'AES-GCM', false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bin.subarray(0, 12) }, k, bin.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function renderPdf(bytes, host) {
    host.replaceChildren();
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const v1 = pg.getViewport({ scale: 1 }), [x0, y0] = pg.view;
      const wrap = el('div', 'pg'); wrap.dataset.i = i - 1; wrap.style.aspectRatio = `${v1.width} / ${v1.height}`;
      const cv = document.createElement('canvas'), ov = el('div', 'ov');
      wrap.append(cv, ov); host.append(wrap);
      pages.push({ w: v1.width, h: v1.height, x0, y0 });
      const scale = Math.max(1, (host.clientWidth || 700) / v1.width) * Math.min(2, devicePixelRatio || 1);
      const vp = pg.getViewport({ scale });
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    return pages;
  }
  function boxes(host, pages, signers) {
    host.querySelectorAll('.ov').forEach(o => o.replaceChildren());
    for (const s of signers) {
      const P = pages[s.page], ov = host.querySelector(`.pg[data-i="${s.page}"] .ov`);
      if (!P || !ov) continue;
      const b = el('div', 'box');
      b.style.left = ((s.x - P.x0) / P.w * 100) + '%'; b.style.bottom = ((s.y - P.y0) / P.h * 100) + '%';
      b.style.width = (s.w / P.w * 100) + '%'; b.style.height = (s.h / P.h * 100) + '%';
      b.append(el('span', 'bl', 'Assinatura de ' + (s.name || 'signatário')));
      ov.append(b);
    }
  }

  /* Quadro de rubrica: traços em 0..1000 relativos à largura */
  function makePad(cv, hint) {
    const pad = { strokes: [], cur: null };
    const draw = () => {
      const g = cv.getContext('2d'), w = cv.width;
      g.clearRect(0, 0, cv.width, cv.height); g.strokeStyle = '#14245f'; g.lineWidth = Math.max(2, w / 260); g.lineCap = g.lineJoin = 'round';
      for (const s of pad.strokes) { g.beginPath(); for (let i = 0; i + 1 < s.length; i += 2) { const x = s[i] / 1000 * w, y = s[i + 1] / 1000 * w; i ? g.lineTo(x, y) : g.moveTo(x, y); } if (s.length === 2) g.lineTo(s[0] / 1000 * w + 0.5, s[1] / 1000 * w); g.stroke(); }
      if (hint) hint.hidden = pad.strokes.length > 0;
    };
    const pt = e => { const r = cv.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / r.width * 1000), Math.round((e.clientY - r.top) / r.width * 1000)]; };
    cv.addEventListener('pointerdown', e => { e.preventDefault(); cv.setPointerCapture(e.pointerId); pad.cur = pt(e); pad.strokes.push(pad.cur); draw(); });
    cv.addEventListener('pointermove', e => { if (!pad.cur) return; const [x, y] = pt(e), n = pad.cur.length; if (Math.hypot(x - pad.cur[n - 2], y - pad.cur[n - 1]) >= 4) { pad.cur.push(x, y); draw(); } });
    const end = () => { pad.cur = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    pad.size = () => { const r = cv.getBoundingClientRect(), k = Math.min(2, devicePixelRatio || 1); cv.width = Math.round(r.width * k); cv.height = Math.round(r.height * k); draw(); };
    pad.clear = () => { pad.strokes = []; draw(); };
    pad.points = () => pad.strokes.reduce((t, s) => t + s.length / 2, 0);
    return pad;
  }
  function save(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = el('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { $, el, digits, fmtCpf, maskCpf, cpfOk, cpfInput, fmtWhen, rid, sha, b64, unb64, seal, open, renderPdf, boxes, makePad, save };
})();
