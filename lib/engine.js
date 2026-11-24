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


  /* Símbolo oficial (vaztwin.com/marca/simbolo.svg), desenhado em vetor */
  const SYM_PATH = 'M0 -10H41C43 2 46 18 49 40C51 49 55 54 56.5 59C57 61.5 53 62 50.5 63C51 66 52 68 51.5 71C51 72.5 50 73.5 49.8 75C50 78 52 80 51.5 84C51 89.5 48 91.5 45 92.5C44 100 43 115 42 130H0Z';
  function svgToPdf(d) {
    let o = '';
    const t = d.match(/[MHCZ]|-?\d*\.?\d+/g);
    let i = 0, cx = 0, cy = 0, cmd = '';
    while (i < t.length) {
      if (/[MHCZ]/.test(t[i])) cmd = t[i++];
      if (cmd === 'M') { cx = +t[i++]; cy = +t[i++]; o += `${cx} ${cy} m `; cmd = 'L'; }
      else if (cmd === 'H') { cx = +t[i++]; o += `${cx} ${cy} l `; }
      else if (cmd === 'C') { const a = t.slice(i, i + 6).map(Number); i += 6; cx = a[4]; cy = a[5]; o += `${a.join(' ')} c `; }
      else if (cmd === 'Z') { o += 'h '; }
      else i++;
    }
    return o;
  }
  function symbolStream(ctx) {
    const P = svgToPdf(SYM_PATH);
    const c = 'q 1 0 0 -1 0 120 cm\n116 60 m 116 90.93 90.93 116 60 116 c 29.07 116 4 90.93 4 60 c 4 29.07 29.07 4 60 4 c 90.93 4 116 29.07 116 60 c h W n\n' +
      '1 0.784 0.239 rg 0 0 120 120 re f\n' +
      `q 1 0 0 1 39 0 cm 0.169 0.212 0.788 rg ${P}f Q\n` +
      `q 1 0 0 1 17 0 cm 0.078 0.086 0.122 rg ${P}f Q\n` +
      '0.078 0.086 0.122 rg 0 0 18 120 re f\nQ\n';
    return ctx.register(ctx.stream(c, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 120], Group: { S: 'Transparency', CS: 'DeviceRGB' } }));
  }


  // assinatura em estilo pronto: caminho SVG (y para baixo) preenchido, ajustado ao quadro
  function glyphOps(g, box) {
    if (!g || !g.d || !g.bbox) return '';
    const [x1, y1, x2, y2] = g.bbox;
    const bw = Math.max(x2 - x1, 1), bh = Math.max(y2 - y1, 1);
    const k = Math.min(box.w / bw, box.h / bh);
    const ox = box.x + (box.w - bw * k) / 2, oy = box.y + (box.h - bh * k) / 2;
    const X = v => f(ox + (v - x1) * k), Y = v => f(oy + (y2 - v) * k);
    const t = String(g.d).match(/[MLQCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    let o = `q ${INK} rg\n`, i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
    const num = () => +t[i++];
    while (i < t.length) {
      if (/^[MLQCZ]$/i.test(t[i])) cmd = t[i++].toUpperCase();
      if (cmd === 'M') { cx = sx = num(); cy = sy = num(); o += `${X(cx)} ${Y(cy)} m\n`; cmd = 'L'; }
      else if (cmd === 'L') { cx = num(); cy = num(); o += `${X(cx)} ${Y(cy)} l\n`; }
      else if (cmd === 'Q') {
        const qx = num(), qy = num(), ex = num(), ey = num();
        const c1x = cx + 2 / 3 * (qx - cx), c1y = cy + 2 / 3 * (qy - cy), c2x = ex + 2 / 3 * (qx - ex), c2y = ey + 2 / 3 * (qy - ey);
        o += `${X(c1x)} ${Y(c1y)} ${X(c2x)} ${Y(c2y)} ${X(ex)} ${Y(ey)} c\n`; cx = ex; cy = ey;
      } else if (cmd === 'C') {
        const a = [num(), num(), num(), num(), num(), num()];
        o += `${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])} c\n`; cx = a[4]; cy = a[5];
      } else if (cmd === 'Z') { o += 'h\n'; cx = sx; cy = sy; cmd = ''; }
      else i++;
    }
    return o + 'f\nQ\n';
  }

  function appearance(st, helv, bold) {
    const W = st.w, H = st.h;
    const sigW = W * 0.5;
    let o = '';
    if (st.watermark) {
      // marca d'água: símbolo oficial da Vaz, centralizado, a 5% de opacidade
      const sz = H * 0.92;
      o += `q /GS1 gs ${f(sz / 120)} 0 0 ${f(sz / 120)} ${f((W - sz) / 2)} ${f((H - sz) / 2)} cm /Sym Do Q\n`;
    }
    o += st.glyph ? glyphOps(st.glyph, { x: 4, y: 7, w: sigW - 8, h: H - 14 }) : strokeOps(st.strokes || [], { x: 3, y: 5, w: sigW - 6, h: H - 10 });
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


  const hex = h => L.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const VZ = { indigo: '#2B36C9', indigoTxt: '#232CA6', indigoBg: '#ECEEFB', amarelo: '#FFC83D', tinta: '#14161F', apoio: '#5B5E6B', linha: '#E3E1D9', papel: '#F7F6F2' };
  function certificate(doc, helv, bold, info) {
    const lastSize = doc.getPage(doc.getPageCount() - 1).getSize();
    const W = lastSize.width > lastSize.height ? 595.28 : lastSize.width, H = lastSize.width > lastSize.height ? 841.89 : lastSize.height;
    const page = doc.addPage([W, H]);
    const M = 48, white = L.rgb(1, 1, 1);
    const txt = (t, x, y, o = {}) => page.drawText(String(t), { x, y, size: o.size || 9, font: o.bold ? bold : helv, color: hex(o.color || VZ.tinta), opacity: o.opacity });
    const lines = (t, font, size, maxW) => wrap(font, t, size, maxW);
    // faixa de marca
    page.drawRectangle({ x: 0, y: H - 92, width: W, height: 92, color: hex(VZ.indigo) });
    page.drawRectangle({ x: 0, y: H - 96, width: W, height: 4, color: hex(VZ.amarelo) });
    const sym = info.symRef();
    const symName = page.node.newXObject('VzSym', sym);
    const gsName = page.node.newExtGState('VzGS', doc.context.obj({ Type: 'ExtGState', ca: 0.04, CA: 0.04 }));
    const putSym = (x, y, size, faint) => page.pushOperators(L.pushGraphicsState(), ...(faint ? [L.setGraphicsState(gsName)] : []), L.concatTransformationMatrix(size / 120, 0, 0, size / 120, x, y), L.drawObject(symName), L.popGraphicsState());
    // marca d'água: símbolo grande, bem sutil, no fundo
    putSym(W - 330, -90, 420, true);
    page.drawCircle({ x: M + 23, y: H - 46, size: 24.5, color: white });
    putSym(M, H - 69, 46, false);
    page.drawText('Vaz Inovação', { x: M + 58, y: H - 44, size: 17, font: bold, color: white });
    page.drawText('Assinatura eletrônica de documentos', { x: M + 58, y: H - 60, size: 8.5, font: helv, color: white, opacity: 0.85 });
    const r1 = 'Assinador Vaz', r2 = 'Registro de assinaturas';
    page.drawText(r1, { x: W - M - bold.widthOfTextAtSize(r1, 11), y: H - 50, size: 11, font: bold, color: white });
    page.drawText(r2, { x: W - M - helv.widthOfTextAtSize(r2, 9), y: H - 66, size: 9, font: helv, color: white, opacity: 0.85 });
    let y = H - 138;
    txt('Registro de assinatura eletrônica', M, y, { size: 20, bold: true });
    y -= 20;
    for (const l of lines('Esta página integra o documento e reúne as evidências das assinaturas eletrônicas feitas pelo Assinador Vaz.', helv, 9.5, W - 2 * M)) { txt(l, M, y, { size: 9.5, color: VZ.apoio }); y -= 13; }
    const section = t => { y -= 14; txt(t, M, y, { size: 11, bold: true, color: VZ.indigoTxt }); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: hex(VZ.linha) }); y -= 16; };
    const row = (k, v, mono) => {
      txt(k, M, y, { size: 8.5, color: VZ.apoio });
      const ls = lines(v, mono ? helv : helv, mono ? 7.8 : 9, W - 2 * M - 120);
      ls.forEach((l, i) => txt(l, M + 120, y - i * 11.5, { size: mono ? 7.8 : 9 }));
      y -= Math.max(1, ls.length) * 11.5 + 4;
    };
    section('Documento');
    row('Título', info.title || '—');
    if (info.fileName) row('Arquivo original', info.fileName);
    row('Páginas do original', String(info.pages));
    if (info.from) row('Enviado por', info.from);
    row('SHA-256 do original', String(info.hash).replace(/(.{32})/, '$1 '), true);
    section('Assinaturas');
    for (const s of info.signers) {
      const cardH = 118;
      if (y - cardH < 150) break;
      page.drawRectangle({ x: M, y: y - cardH + 10, width: W - 2 * M, height: cardH, color: white, borderColor: hex(VZ.linha), borderWidth: 0.8 });
      page.drawRectangle({ x: M, y: y - cardH + 10, width: 3, height: cardH, color: hex(VZ.amarelo) });
      // rubrica
      const bx = M + 14, bw = 168, bh = 62, by = y - 78;
      page.drawLine({ start: { x: bx, y: by + 8 }, end: { x: bx + bw, y: by + 8 }, thickness: 0.5, color: hex(VZ.linha) });
      const st = s.strokes || [];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const k of st) for (let i = 0; i + 1 < k.length; i += 2) { x0 = Math.min(x0, k[i]); x1 = Math.max(x1, k[i]); y0 = Math.min(y0, k[i + 1]); y1 = Math.max(y1, k[i + 1]); }
      if (s.glyph && s.glyph.d && s.glyph.bbox) {
        const [gx1, gy1, gx2, gy2] = s.glyph.bbox;
        const sc = Math.min((bw - 8) / Math.max(gx2 - gx1, 1), (bh - 8) / Math.max(gy2 - gy1, 1));
        const ox = bx + (bw - (gx2 - gx1) * sc) / 2, top = by + bh - (bh - (gy2 - gy1) * sc) / 2;
        page.drawSvgPath(s.glyph.d, { x: ox - gx1 * sc, y: top + gy1 * sc, scale: sc, color: hex('#1A2580') });
      } else if (st.length) {
        const sc = Math.min((bw - 8) / Math.max(x1 - x0, 1), (bh - 8) / Math.max(y1 - y0, 1));
        const ox = bx + (bw - (x1 - x0) * sc) / 2, top = by + bh - (bh - (y1 - y0) * sc) / 2;
        for (const k of st) {
          if (k.length < 4) continue;
          let d = '';
          for (let i = 0; i + 1 < k.length; i += 2) d += (i ? 'L' : 'M') + f((k[i] - x0) * sc) + ' ' + f((k[i + 1] - y0) * sc);
          page.drawSvgPath(d, { x: ox, y: top, borderColor: hex('#1A2580'), borderWidth: 1.2, borderLineCap: L.LineCapStyle.Round });
        }
      }
      txt('Rubrica', bx, by - 4, { size: 7, color: VZ.apoio });
      // dados
      let tx = bx + bw + 18, ty = y - 8;
      const tw = W - M - 12 - tx;
      const put = (t, o = {}) => { for (const l of lines(t, o.bold ? bold : helv, o.size || 8.5, tw)) { txt(l, tx, ty, o); ty -= (o.size || 8.5) * 1.35; } };
      put(s.name, { size: 11, bold: true });
      put(`CPF ${s.cpf}`, { size: 8.5 });
      if (s.role) put(s.role, { size: 8.5, color: VZ.apoio });
      put(`Assinado em ${s.when}`, { size: 8.5 });
      put(`Código de verificação ${s.code}`, { size: 8.5, bold: true, color: VZ.indigoTxt });
      put(s.method || (s.glyph ? 'Link pessoal, confirmação do CPF e assinatura em estilo escolhido pelo signatário' : 'Link pessoal, confirmação do CPF e rubrica manuscrita'), { size: 7.5, color: VZ.apoio });
      if (s.ua) put('Navegador: ' + String(s.ua).slice(0, 150), { size: 6.8, color: VZ.apoio });
      y -= cardH + 6;
    }
    // nota legal
    const note = 'Assinatura eletrônica feita por link pessoal, com confirmação do CPF do signatário e assinatura feita por ele no próprio aparelho (rubrica desenhada ou estilo escolhido), admitida pelas partes nos termos do art. 10, § 2º, da Medida Provisória nº 2.200-2/2001. Os carimbos e este registro foram incluídos por atualização incremental: o conteúdo original e eventuais assinaturas digitais anteriores (ICP-Brasil) permanecem preservados e verificáveis. A integridade do original pode ser conferida pelo SHA-256 acima.';
    const nl = lines(note, helv, 8, W - 2 * M - 24), nh = nl.length * 11 + 20;
    const ny = Math.max(y - 4, 70 + nh);
    page.drawRectangle({ x: M, y: ny - nh, width: W - 2 * M, height: nh, color: hex(VZ.papel) });
    nl.forEach((l, i) => txt(l, M + 12, ny - 16 - i * 11, { size: 8, color: VZ.apoio }));
    // rodapé
    page.drawLine({ start: { x: M, y: 52 }, end: { x: W - M, y: 52 }, thickness: 0.6, color: hex(VZ.linha) });
    txt('Vaz Inovação e Participação Ltda · Assinador Vaz', M, 38, { size: 7.5, color: VZ.apoio });
    const gen = 'Registro gerado em ' + (info.generated || '');
    txt(gen, W - M - helv.widthOfTextAtSize(gen, 7.5), 38, { size: 7.5, color: VZ.apoio });
  }

  async function sign(bytes, stamps, opts = {}) {
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
    let _sym = null;
    const symRef = () => (_sym ||= symbolStream(ctx));
    const touched = new Set();
    const snap = new Map();
    for (const [r, o] of ctx.enumerateIndirectObjects()) if (!(o instanceof L.PDFStream)) snap.set(r, serStr(o));
    const pages = doc.getPages();
    const origPages = pages.length;
    for (const st of stamps) {
      const page = pages[st.page];
      if (!page) throw new Error('Página inexistente: ' + (st.page + 1));
      const ap = ctx.stream(appearance(st, helv, bold), {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, st.w, st.h],
        Resources: { Font: { F1: helv.ref, F2: bold.ref }, XObject: { Sym: symRef() }, ExtGState: { GS1: { Type: 'ExtGState', ca: 0.05, CA: 0.05 } } },
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
    if (opts.certificate) certificate(doc, helv, bold, { ...opts.certificate, pages: opts.certificate.pages || origPages, symRef });
    for (const [r, str] of snap) { const o = ctx.lookup(r); if (o && serStr(o) !== str) touched.add(r); }
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
