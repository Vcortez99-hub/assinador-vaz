/* Motor de carimbo: aplica assinaturas eletrônicas como anotações /Stamp
   numa atualização incremental, sem tocar nos bytes já assinados do PDF. */
const SignEngine = (() => {
  const L = globalThis.PDFLib;
  const enc = new TextEncoder();
  const INK = '0.078 0.141 0.373';

  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }
  function lit(str) {
    let o = '(';
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (ch === '(' || ch === ')' || ch === '\\') o += '\\' + ch;
      else if (c >= 32 && c < 127) o += ch;
      else if (c >= 160 && c <= 255) o += '\\' + c.toString(8).padStart(3, '0');
      else if (c === 0x2013) o += '\\226';
      else if (c === 0x2014) o += '\\227';
      else if (c === 0x2022) o += '\\225';
      else o += '?';
    }
    return o + ')';
  }
  function ser(obj) {
    const b = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(b, 0);
    return b;
  }
  function serStr(obj) { return latin1(ser(obj)); }
  function f(n) { return (Math.round(n * 100) / 100).toString(); }
  function safeWidth(font, t, size) {
    try { return font.widthOfTextAtSize(t, size); } catch { return t.length * size * 0.55; }
  }
  function wrap(font, text, size, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (safeWidth(font, t, size) <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // strokes: [[x,y,x,y,...], ...] em 0..1000, origem no topo-esquerdo do quadro de rubrica
  function strokeOps(strokes, box) {
    const pts = strokes.flat();
    if (!pts.length) return '';
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of strokes) for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
    }
    const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
    const k = Math.min(box.w / bw, box.h / bh);
    const ox = box.x + (box.w - bw * k) / 2, oy = box.y + (box.h - bh * k) / 2;
    const X = v => ox + (v - x0) * k, Y = v => oy + (y1 - v) * k;
    let o = `q ${INK} RG 1.05 w 1 J 1 j\n`;
    for (const s of strokes) {
      if (s.length < 2) continue;
      o += `${f(X(s[0]))} ${f(Y(s[1]))} m\n`;
      if (s.length === 2) o += `${f(X(s[0]) + 0.3)} ${f(Y(s[1]))} l\n`;
      for (let i = 2; i < s.length; i += 2) o += `${f(X(s[i]))} ${f(Y(s[i + 1]))} l\n`;
      o += 'S\n';
    }
    return o + 'Q\n';
  }

  function appearance(st, helv, bold) {
    const W = st.w, H = st.h;
    const sigW = W * 0.5;
    let o = '';
    if (st.watermark) {
      // marca d'água: texto grande, tinta a 8% de opacidade, atrás de tudo
      const wm = String(st.watermark);
      let ws = H * 0.95;
      const ww = safeWidth(bold, wm, ws);
      if (ww > W * 0.92) ws *= (W * 0.92) / ww;
      const wx = (W - safeWidth(bold, wm, ws)) / 2, wy = (H - ws * 0.72) / 2;
      o += `q /GS1 gs ${INK} rg BT /F2 ${f(ws)} Tf ${f(wx)} ${f(wy)} Td ${lit(wm)} Tj ET Q\n`;
    }
    o += strokeOps(st.strokes || [], { x: 3, y: 5, w: sigW - 6, h: H - 10 });
    const tx = sigW + 5, maxW = W - tx - 3;
    o += `q 0.62 0.64 0.7 RG 0.4 w ${f(tx - 4)} 5 m ${f(tx - 4)} ${f(H - 5)} l S Q\n`;
    let size = 5.4;
    let name = wrap(bold, st.name.toUpperCase(), size, maxW);
    while (name.length > 2 && size > 4) { size -= 0.3; name = wrap(bold, st.name.toUpperCase(), size, maxW); }
    const lines = [['F1', 'Assinado eletronicamente por']]
      .concat(name.map(t => ['F2', t]))
      .concat([['F1', 'CPF: ' + st.cpf], ['F1', 'Data: ' + st.when], ['F1', 'Código: ' + st.code]]);
    const lead = size * 1.2;
    let y = H / 2 + (lines.length * lead) / 2 - size * 0.85;
    for (const [fn, t] of lines) {
      let s = size;
      const font = fn === 'F2' ? bold : helv;
      while (safeWidth(font, t, s) > maxW && s > 3.6) s -= 0.2;
      o += `BT 0.13 0.14 0.18 rg /${fn} ${f(s)} Tf ${f(tx)} ${f(y)} Td ${lit(t)} Tj ET\n`;
      y -= lead;
    }
    return o;
  }

  async function sign(bytes, stamps) {
    const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    // xref streams antigos não entram no contexto do pdf-lib: o maior número vem do próprio arquivo
    const whole = latin1(bytes);
    let fileMax = ctx.largestObjectNumber;
    for (const m of whole.matchAll(/\/Size\s+(\d+)/g)) fileMax = Math.max(fileMax, +m[1] - 1);
    for (const m of whole.matchAll(/(?:^|[\r\n\s>])(\d+)\s+\d+\s+obj\b/g)) fileMax = Math.max(fileMax, +m[1]);
    ctx.largestObjectNumber = fileMax;
    const origMax = fileMax;
    const helv = await doc.embedStandardFont(L.StandardFonts.Helvetica);
    const bold = await doc.embedStandardFont(L.StandardFonts.HelveticaBold);
    await helv.embed(); await bold.embed();
    const touched = new Set();
    const pages = doc.getPages();
    for (const st of stamps) {
      const page = pages[st.page];
      if (!page) throw new Error('Página inexistente: ' + (st.page + 1));
      const ap = ctx.stream(appearance(st, helv, bold), {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, st.w, st.h],
        Resources: { Font: { F1: helv.ref, F2: bold.ref }, ExtGState: { GS1: { Type: 'ExtGState', ca: 0.08, CA: 0.08 } } },
      });
      const apRef = ctx.register(ap);
      const annot = ctx.obj({
        Type: 'Annot', Subtype: 'Stamp', Rect: [st.x, st.y, st.x + st.w, st.y + st.h], F: 132,
        AP: { N: apRef }, P: page.ref,
      });
      annot.set(L.PDFName.of('T'), L.PDFHexString.fromText(st.name));
      annot.set(L.PDFName.of('NM'), L.PDFString.of('vaz-' + st.code));
      annot.set(L.PDFName.of('M'), L.PDFString.fromDate(new Date(st.at)));
      annot.set(L.PDFName.of('Contents'), L.PDFHexString.fromText(st.contents || ''));
      const aRef = ctx.register(annot);
      const raw = page.node.get(L.PDFName.of('Annots'));
      if (raw instanceof L.PDFRef) { ctx.lookup(raw, L.PDFArray).push(aRef); touched.add(raw); }
      else if (raw instanceof L.PDFArray) { raw.push(aRef); touched.add(page.ref); }
      else { page.node.set(L.PDFName.of('Annots'), ctx.obj([aRef])); touched.add(page.ref); }
    }
    const objs = ctx.enumerateIndirectObjects()
      .filter(([r]) => r.objectNumber > origMax || touched.has(r))
      .sort((a, b) => a[0].objectNumber - b[0].objectNumber);

    const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 4096)));
    const sx = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
    if (!sx) throw new Error('PDF sem startxref');
    const prev = +sx[1];
    const isStream = !latin1(bytes.subarray(prev, prev + 4)).startsWith('xref');

    const parts = [];
    let off = bytes.length;
    const push = u8 => { parts.push(u8); off += u8.length; };
    const lastByte = bytes[bytes.length - 1];
    push(enc.encode(lastByte === 10 || lastByte === 13 ? '' : '\n'));
    const entries = [];
    for (const [r, o] of objs) {
      entries.push([r.objectNumber, r.generationNumber, off]);
      push(enc.encode(`${r.objectNumber} ${r.generationNumber} obj\n`));
      push(ser(o));
      push(enc.encode('\nendobj\n'));
    }
    const ti = ctx.trailerInfo;
    const refS = r => `${r.objectNumber} ${r.generationNumber} R`;
    let common = `/Root ${refS(ti.Root)}`;
    if (ti.Info) common += ` /Info ${refS(ti.Info)}`;
    if (ti.ID) common += ` /ID ${serStr(ti.ID)}`;
    common += ` /Prev ${prev}`;
    let maxNum = ctx.largestObjectNumber;
    const groups = list => {
      const g = [];
      for (const e of list) {
        const last = g[g.length - 1];
        if (last && last.start + last.items.length === e[0]) last.items.push(e);
        else g.push({ start: e[0], items: [e] });
      }
      return g;
    };
    const xrefOff = off;
    if (isStream) {
      const num = maxNum + 1;
      const all = entries.concat([[num, 0, xrefOff]]).sort((a, b) => a[0] - b[0]);
      const data = new Uint8Array(all.length * 7);
      all.forEach(([, gen, o], i) => {
        const p = i * 7;
        data[p] = 1;
        data[p + 1] = (o >>> 24) & 255; data[p + 2] = (o >>> 16) & 255; data[p + 3] = (o >>> 8) & 255; data[p + 4] = o & 255;
        data[p + 5] = (gen >> 8) & 255; data[p + 6] = gen & 255;
      });
      const idx = groups(all).map(g => `${g.start} ${g.items.length}`).join(' ');
      push(enc.encode(`${num} 0 obj\n<< /Type /XRef /Size ${num + 1} /W [1 4 2] /Index [${idx}] ${common} /Length ${data.length} >>\nstream\n`));
      push(data);
      push(enc.encode('\nendstream\nendobj\n'));
    } else {
      let s = 'xref\n';
      for (const g of groups(entries)) {
        s += `${g.start} ${g.items.length}\n`;
        for (const [, gen, o] of g.items) s += `${String(o).padStart(10, '0')} ${String(gen).padStart(5, '0')} n \n`;
      }
      s += `trailer\n<< /Size ${maxNum + 1} ${common} >>\n`;
      push(enc.encode(s));
    }
    push(enc.encode(`startxref\n${xrefOff}\n%%EOF\n`));
    const out = new Uint8Array(off);
    out.set(bytes, 0);
    let p = bytes.length;
    for (const u of parts) { out.set(u, p); p += u.length; }
    return out;
  }
  return { sign };
})();
