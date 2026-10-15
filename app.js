// Ofertazera — ofertas do canal de consoles do Discord, no estilo dos classificados.
//
// Os dados vêm do PC: a extensão lê a aba do Discord e o server.py guarda.
// No PC (localhost) o app lê direto do server.py (/api/...); fora dele (GitHub Pages, celular),
// lê o ofertas.json que o server.py publica no Gist do Ofertazera. Favoritos ficam só neste aparelho.
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const NO_PC = ['localhost', '127.0.0.1'].includes(location.hostname);
const K = { favoritos: 'ofertazera:favoritos', push: 'ofertazera:push', filtro: 'ofertazera:filtro', cache: 'ofertazera:cache' };
const ATUALIZAR_MS = 15000; // celular: confere o Gist a cada 15 s com o app aberto

const S = {
  ofertas: [], status: null, alertas: { ts: 0, notificarTodas: false, alertas: [] },
  filtro: localStorage.getItem(K.filtro) || 'todas', q: '', erro: '', publicadoEm: 0,
  vistos: new Set(), desenhados: new Set(), pendentes: 0, lastIngest: 0, carregando: false,
  favoritos: new Set(lerJSON(K.favoritos, [])),
};

const ICON = {
  img: '<svg viewBox="0 0 24 24"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21 10.6 19.7C5.4 15.1 2 12 2 8.4 2 5.4 4.4 3 7.4 3c1.7 0 3.4.8 4.6 2.1A6.1 6.1 0 0 1 16.6 3C19.6 3 22 5.4 22 8.4c0 3.6-3.4 6.7-8.6 11.3L12 21Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>',
};

// ---------------------------------------------------------------- utils
function lerJSON(chave, padrao) {
  try { return JSON.parse(localStorage.getItem(chave)) ?? padrao; } catch { return padrao; }
}
function gravarJSON(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* armazenamento cheio/bloqueado */ }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const brl = (v) => v == null ? '' : 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
function ago(ms) {
  if (!ms) return '';
  const d = (Date.now() - ms) / 1000;
  if (d < 45) return 'agora';
  if (d < 3600) return `há ${Math.round(d / 60)} min`;
  if (d < 86400) return `há ${Math.round(d / 3600)} h`;
  const dt = new Date(ms);
  const h = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d < 172800) return 'ontem ' + h;
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) + ' ' + h;
}
const isNew = (o) => Date.now() - o.posted_at < 15 * 60 * 1000;
const discount = (o) => o.old_price && o.price ? Math.round((1 - o.price / o.old_price) * 100) : 0;
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + '…' : u}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/`([^`]+)`/g, '<span class="code">$1</span>');
}
function base64url(texto) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deBase64url(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function api(path, opts = {}) {
  const r = await fetch('/api/' + path, {
    headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return r.json();
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* cai no fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, 99999);
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.14);
      o.start(ctx.currentTime + i * 0.15); o.stop(ctx.currentTime + i * 0.15 + 0.15);
    });
  } catch { /* sem áudio */ }
}
function carregarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('sem conexão'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- dados
// PC: server.py (/api). Celular: Gist (ofertas.json + alertas.json numa chamada só).
async function carregar({ manual = false } = {}) {
  if (S.carregando) return;
  S.carregando = true;
  try {
    let ofertas, status, alertas;
    if (NO_PC) {
      [ofertas, status, alertas] = await Promise.all([api('offers?limit=300'), api('status'), api('alertas')]);
      S.publicadoEm = Date.now();
    } else if (Sync.enabled()) {
      const arq = await Sync.ler({ 'ofertas.json': null, 'alertas.json': null });
      const pub = arq['ofertas.json'];
      if (!pub || !pub.ofertas) throw new Error('o PC ainda não publicou ofertas (o server.py está rodando?)');
      ofertas = pub.ofertas; status = pub.status; S.publicadoEm = pub.ts;
      alertas = arq['alertas.json'] || S.alertas;
    } else {
      S.carregando = false;
      return rotear();
    }
    const novos = S.vistos.size ? ofertas.filter((o) => !S.vistos.has(o.id)) : [];
    ofertas.forEach((o) => S.vistos.add(o.id));
    S.ofertas = ofertas; S.status = status; S.alertas = alertas; S.erro = '';
    if (!NO_PC) gravarJSON(K.cache, { ofertas, status, alertas, ts: S.publicadoEm });
    if (novos.length) chegaramNovas(novos);
    if (manual) toast('Atualizado');
  } catch (err) {
    S.erro = err.message;
    if (manual) toast(`Não foi possível atualizar: ${err.message}`);
  } finally {
    S.carregando = false;
    atualizarSelo();
    redesenhar();
  }
}

function chegaramNovas(novos) {
  if (window.scrollY > 300 && rotaAtual().tab === 'home') S.pendentes += novos.length;
  if (document.visibilityState === 'visible') {
    if (novos.some((o) => o.matched?.length)) { beep(); navigator.vibrate?.([200, 100, 200]); }
    toast(`${novos.length} oferta${novos.length > 1 ? 's' : ''} nova${novos.length > 1 ? 's' : ''}!`);
  }
}

function monitorando() {
  if (!S.status) return false;
  // No celular, o ofertas.json velho (PC desligado) também conta como parado
  const fresco = NO_PC || Date.now() - S.publicadoEm < 10 * 60 * 1000;
  return Boolean(S.status.monitorando && fresco);
}
function atualizarSelo() {
  const el = $('#live');
  const on = monitorando();
  el.className = 'live ' + (on ? 'on' : 'off');
  el.querySelector('b').textContent = on ? 'ao vivo' : (!NO_PC && !Sync.enabled() ? 'conectar' : 'offline');
}

function filtradas() {
  const termos = semAcento(S.q).split(/\s+/).filter(Boolean);
  return S.ofertas.filter((o) => {
    if (S.filtro === 'alertas' && !o.matched?.length) return false;
    if (S.filtro === 'cupom' && !o.coupon && !o.coupon_note) return false;
    if (S.filtro.startsWith('a:') && !o.matched?.includes(S.filtro.slice(2))) return false;
    if (S.filtro.startsWith('c:') && o.channel !== S.filtro.slice(2)) return false;
    const texto = semAcento(`${o.title} ${o.text} ${o.store || ''}`);
    return termos.every((t) => texto.includes(t));
  });
}

// Canais com ofertas (nome guardado pelo server.py a partir do título da aba)
function canaisConhecidos() {
  const nomes = S.status?.nomesCanais || {};
  const ids = [...new Set(S.ofertas.map((o) => o.channel).filter(Boolean))];
  return ids.map((id) => [id, nomes[id] || 'canal']);
}
function nomeCanal(o) {
  return canaisConhecidos().length > 1 ? (S.status?.nomesCanais || {})[o.channel] || '' : '';
}

// Foto que não abre (ex.: link do Discord expirado): tenta a próxima da oferta; sem nenhuma, fica o ícone
function fotoFalhou(img) {
  const alts = (img.dataset.alts || '').split(' ').filter(Boolean);
  if (!alts.length) { img.remove(); return; }
  img.dataset.alts = alts.slice(1).join(' ');
  img.src = alts[0];
}

// ---------------------------------------------------------------- cards
function card(o) {
  const d = discount(o);
  const novo = !S.desenhados.has(o.id); S.desenhados.add(o.id);
  return `
  <a class="card ${o.matched?.length ? 'match' : ''} ${novo ? 'card-new' : ''}" href="#/oferta/${esc(o.id)}">
    <div class="thumb">
      ${ICON.img}${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-alts="${esc((o.images || []).filter((i) => i !== o.image).join(' '))}" onerror="fotoFalhou(this)">` : ''}
      ${isNew(o) ? '<span class="badge-new">NOVO</span>' : ''}
    </div>
    <div class="info">
      <p class="title">${esc(o.title)}</p>
      ${o.matched?.length ? `<div class="tags">${o.matched.map((m) => `<span class="tag">🎯 ${esc(m)}</span>`).join('')}</div>` : ''}
      ${o.price ? `<div class="price-row"><span class="price">${brl(o.price)}</span>${o.old_price ? `<span class="old">${brl(o.old_price)}</span>` : ''}${d > 0 ? `<span class="off">-${d}%</span>` : ''}</div>` : ''}
      ${o.coupon ? `<button class="coupon" data-copy="${esc(o.coupon)}">${ICON.copy}${esc(o.coupon)}${(o.coupons?.length || 0) > 1 ? ` <span class="mais">+${o.coupons.length - 1}</span>` : ''}</button>` : o.coupon_note ? `<span class="coupon note">🎟️ ${esc(o.coupon_note)}</span>` : ''}
      <div class="meta"><span class="store">${esc(o.store || 'Oferta')}${nomeCanal(o) ? ` · <span class="canal">#${esc(nomeCanal(o))}</span>` : ''}</span><span>${ago(o.posted_at)}</span></div>
    </div>
    <button class="fav-btn ${S.favoritos.has(o.id) ? 'on' : ''}" data-fav="${esc(o.id)}" aria-label="Favoritar">${ICON.heart}</button>
  </a>`;
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) {
    e.preventDefault(); e.stopPropagation();
    toast((await copy(c.dataset.copy)) ? `Cupom ${c.dataset.copy} copiado!` : 'Não deu para copiar — segure o texto');
    return;
  }
  const f = e.target.closest('[data-fav]');
  if (f) {
    e.preventDefault(); e.stopPropagation();
    const id = f.dataset.fav;
    if (S.favoritos.has(id)) S.favoritos.delete(id); else S.favoritos.add(id);
    gravarJSON(K.favoritos, [...S.favoritos]);
    f.classList.toggle('on', S.favoritos.has(id));
    toast(S.favoritos.has(id) ? 'Salvo nos favoritos' : 'Removido dos favoritos');
  }
});

// ---------------------------------------------------------------- telas
function telaConectar() {
  return `<div class="empty"><b>🔗 Conecte este celular ao PC</b>
    No PC: Ofertazera → Ajustes → <b>Mostrar QR code</b>. Aqui: Ajustes → <b>Ler QR do PC</b>.
    <p><a class="btn btn-purple" href="#/ajustes">Conectar</a></p></div>`;
}

function renderHome(soFavoritos = false) {
  if (!NO_PC && !Sync.enabled()) { view.innerHTML = telaConectar(); return; }
  const lista = soFavoritos ? S.ofertas.filter((o) => S.favoritos.has(o.id)) : filtradas();
  const conta = (fn) => S.ofertas.filter(fn).length;
  const chips = soFavoritos ? '' : `
    <div class="chips">
      ${[['todas', 'Tudo', S.ofertas.length], ['alertas', '🎯 Meus alertas', conta((o) => o.matched?.length)], ['cupom', '🏷️ Com cupom', conta((o) => o.coupon || o.coupon_note)]]
        .map(([k, l, n]) => `<button class="chip ${S.filtro === k ? 'active' : ''}" data-filter="${k}">${l}<span class="n">${n}</span></button>`).join('')}
      ${canaisConhecidos().length > 1 ? canaisConhecidos().map(([id, nome]) => `<button class="chip ${S.filtro === 'c:' + id ? 'active' : ''}" data-filter="c:${esc(id)}">#${esc(nome)}<span class="n">${conta((o) => o.channel === id)}</span></button>`).join('') : ''}
      ${S.alertas.alertas.filter((a) => a.ativo).map((a) => `<button class="chip ${S.filtro === 'a:' + a.nome ? 'active' : ''}" data-filter="a:${esc(a.nome)}">${esc(a.nome)}<span class="n">${conta((o) => o.matched?.includes(a.nome))}</span></button>`).join('')}
    </div>`;
  const titulo = soFavoritos ? 'Favoritos' : S.q ? `Resultados para “${esc(S.q)}”` : 'Ofertas recentes';
  const aviso = S.erro ? `<div class="aviso">Não foi possível atualizar: ${esc(S.erro)}</div>`
    : (!monitorando() && S.status) ? `<div class="aviso">⚠️ O PC não está monitorando o Discord agora${S.status.ultimoSinal ? ` (último sinal ${ago(S.status.ultimoSinal)})` : ''}. Abra o canal no Chrome do PC.</div>` : '';
  view.innerHTML = `
    ${chips}${aviso}
    ${S.pendentes ? `<button class="new-banner" id="newBanner">↑ ${S.pendentes} nova${S.pendentes > 1 ? 's' : ''}</button>` : ''}
    <h2 class="section-title">${titulo}<small>${lista.length} anúncio${lista.length === 1 ? '' : 's'}</small></h2>
    <div class="list">${lista.map(card).join('')}</div>
    ${lista.length ? '' : `<div class="empty"><b>${soFavoritos ? 'Nenhum favorito ainda' : 'Nenhuma oferta por aqui'}</b>
      ${soFavoritos ? 'Toque no ♥ de uma oferta para salvar.' : 'Deixe o canal aberto no Chrome do PC com a extensão ativa. As ofertas aparecem aqui na hora.'}</div>`}`;
  view.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => {
    S.filtro = b.dataset.filter; localStorage.setItem(K.filtro, S.filtro); S.pendentes = 0; renderHome();
  });
  const nb = $('#newBanner');
  if (nb) nb.onclick = () => { S.pendentes = 0; window.scrollTo({ top: 0, behavior: 'smooth' }); renderHome(); };
}

function renderDetail(id, resumo) {
  // A notificação traz um resumo (?d=): abre na hora, mesmo antes do Gist atualizar
  const o = S.ofertas.find((x) => x.id === id) || (resumo && { links: [], images: [], matched: [], text: '', ...resumo });
  if (!o) {
    view.innerHTML = '<div class="empty"><b>Carregando oferta…</b></div>';
    return;
  }
  const d = discount(o);
  const imagens = o.images?.length ? o.images : (o.image ? [o.image] : []);
  view.innerHTML = `
  <div class="detail">
    <div class="hero" id="hero">${imagens[0] ? `<img src="${esc(imagens[0])}" alt="" referrerpolicy="no-referrer">` : ICON.img}</div>
    ${imagens.length > 1 ? `<div class="gallery">${imagens.map((src, i) => `<img src="${esc(src)}" class="${i ? '' : 'sel'}" alt="" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="color:var(--muted);font-size:13px">${esc(o.store || 'Oferta')} · ${ago(o.posted_at)}</span>
        <button class="fav-btn ${S.favoritos.has(o.id) ? 'on' : ''}" data-fav="${esc(o.id)}" style="position:static">${ICON.heart}</button>
      </div>
      <h1>${esc(o.title)}</h1>
      ${o.matched?.length ? `<div class="tags">${o.matched.map((m) => `<span class="tag">🎯 ${esc(m)}</span>`).join('')}</div>` : ''}
      ${o.price ? `<div class="price-row"><span class="price">${brl(o.price)}</span>${o.old_price ? `<span class="old">${brl(o.old_price)}</span>` : ''}${d > 0 ? `<span class="off">-${d}% OFF</span>` : ''}</div>` : ''}
      ${(o.coupons?.length ? o.coupons : o.coupon ? [o.coupon] : []).map((c, i, l) => `<div class="coupon-big"><div><small>${l.length > 1 ? `CUPOM ${i + 1} DE ${l.length}` : 'CUPOM DE DESCONTO'}</small><strong>${esc(c)}</strong></div>
        <button class="btn btn-orange btn-sm" data-copy="${esc(c)}">Copiar</button></div>`).join('')}
      ${!o.coupon && o.coupon_note ? `<div class="coupon-big"><div><small>CUPOM PARA RESGATAR</small><strong style="font-size:17px">🎟️ ${esc(o.coupon_note)}</strong></div>
        ${o.coupon_link ? `<a class="btn btn-orange btn-sm" href="${esc(o.coupon_link)}" target="_blank" rel="noopener">Resgatar</a>` : ''}</div>` : ''}
      ${o.text ? `<div class="msg">${linkify(o.text)}</div>` : ''}
      ${o.author ? `<div class="kv"><span>Postado por</span><b>${esc(o.author)}</b><span>Horário</span><b>${new Date(o.posted_at).toLocaleString('pt-BR')}</b></div>` : ''}
    </div>
  </div>
  <div class="cta-bar">
    ${o.coupon_link ? `<a class="btn btn-ghost" href="${esc(o.coupon_link)}" target="_blank" rel="noopener">1º Resgatar cupons</a>` : ''}
    ${o.link ? `<button class="btn btn-orange" id="go">${o.coupon ? 'Copiar cupom e ir à loja' : o.coupon_link ? '2º Ir ao produto' : 'Ir para a oferta'}</button>` : ''}
  </div>`;
  view.querySelectorAll('.gallery img').forEach((img) => img.onclick = () => {
    $('#hero').innerHTML = `<img src="${esc(img.src)}" alt="" referrerpolicy="no-referrer">`;
    view.querySelectorAll('.gallery img').forEach((x) => x.classList.toggle('sel', x === img));
  });
  const go = $('#go');
  if (go) go.onclick = async () => {
    if (o.coupon) { await copy(o.coupon); toast(`Cupom ${o.coupon} copiado!`); }
    window.open(o.link, '_blank', 'noopener');
  };
}

// ---------------------------------------------------------------- alertas
const SUGESTOES = [
  ['PS5', 'ps5, playstation 5 -controle -jogo -capa'],
  ['Xbox Series', 'xbox series'],
  ['Switch 2', 'switch 2, nintendo switch 2'],
  ['Switch OLED', 'switch oled'],
  ['DualSense', 'dualsense, controle ps5'],
  ['Controle Xbox', 'controle xbox'],
  ['Jogos PS5', 'jogo ps5, game ps5'],
  ['Game Pass', 'game pass'],
];
async function salvarAlertas(novo) {
  novo.ts = Date.now();
  try {
    if (NO_PC) S.alertas = await api('alertas', { method: 'POST', body: novo });
    else { await Sync.gravar('alertas.json', novo); S.alertas = novo; }
    toast(NO_PC ? 'Alertas salvos' : 'Alertas salvos — o PC aplica em até 30 s');
  } catch (err) {
    toast(`Não foi possível salvar: ${err.message}`);
  }
  renderAlerts();
}
function renderAlerts() {
  if (!NO_PC && !Sync.enabled()) { view.innerHTML = telaConectar(); return; }
  const lista = S.alertas.alertas || [];
  view.innerHTML = `
  <div class="panel">
    <h2>Criar alerta</h2>
    <p>Quando entrar uma oferta com essas palavras, o celular recebe uma <b>notificação na hora</b>.</p>
    <form id="af">
      <div class="field"><label>Nome do alerta</label><input name="nome" placeholder="Ex.: PS5" required></div>
      <div class="field"><label>Palavras-chave</label><input name="termos" placeholder="ps5, playstation 5 -controle"></div>
      <div class="field"><label>Preço máximo (opcional)</label><input name="precoMax" inputmode="decimal" placeholder="Ex.: 3500"></div>
      <button class="btn btn-purple" style="width:100%">Criar alerta</button>
    </form>
    <p style="margin-top:12px">💡 <b>Vírgula</b> separa alternativas · <b>espaço</b> exige todas as palavras · <b>-palavra</b> exclui. Sem palavras-chave, vale o nome.</p>
    <div class="suggest">${SUGESTOES.map(([n, q]) => `<button class="chip" data-sug="${esc(n)}|${esc(q)}">+ ${esc(n)}</button>`).join('')}</div>
  </div>
  <div class="panel">
    <h2>Meus alertas (${lista.length})</h2>
    ${lista.length ? lista.map((a, i) => `
      <div class="alert-item">
        <div class="a-info"><div class="a-name">${esc(a.nome)}${a.precoMax ? ` <span style="color:var(--green);font-size:12px">até ${brl(a.precoMax)}</span>` : ''}</div>
        <div class="a-q">${esc(a.termos)}</div></div>
        <label class="switch"><input type="checkbox" data-toggle="${i}" ${a.ativo ? 'checked' : ''}><span></span></label>
        <button class="icon-btn" data-del="${i}" aria-label="Excluir">${ICON.trash}</button>
      </div>`).join('') : '<p>Nenhum alerta ainda. Crie um acima ou toque numa sugestão.</p>'}
    <div class="toggle-row" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
      <div><b>Notificar TODAS as ofertas</b><p style="margin:2px 0 0">Desligado: só as que batem com seus alertas.</p></div>
      <label class="switch"><input type="checkbox" id="todas" ${S.alertas.notificarTodas ? 'checked' : ''}><span></span></label>
    </div>
  </div>`;
  const copia = () => ({ ...S.alertas, alertas: lista.map((a) => ({ ...a })) });
  $('#af').onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const preco = fd.precoMax ? parseFloat(fd.precoMax.replace(/\./g, '').replace(',', '.')) : null;
    const novo = copia();
    novo.alertas.push({ nome: fd.nome.trim(), termos: (fd.termos || fd.nome).trim(), precoMax: preco || null, ativo: true });
    salvarAlertas(novo);
  };
  view.querySelectorAll('[data-sug]').forEach((b) => b.onclick = () => {
    const [n, q] = b.dataset.sug.split('|');
    $('#af').nome.value = n; $('#af').termos.value = q; $('#af').precoMax.focus();
  });
  view.querySelectorAll('[data-toggle]').forEach((c) => c.onchange = () => {
    const novo = copia(); novo.alertas[+c.dataset.toggle].ativo = c.checked; salvarAlertas(novo);
  });
  view.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    if (!confirm('Excluir este alerta?')) return;
    const novo = copia(); novo.alertas.splice(+b.dataset.del, 1); salvarAlertas(novo);
  });
  $('#todas').onchange = (e) => { const novo = copia(); novo.notificarTodas = e.target.checked; salvarAlertas(novo); };
}

// ---------------------------------------------------------------- notificações (Web Push)
function pushSuportado() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function chaveParaBytes(b64url) {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function descreverAparelho() {
  const ua = navigator.userAgent;
  const tipo = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Computador';
  return `${tipo} · Ofertazera (ativado em ${new Date().toLocaleDateString('pt-BR')})`;
}
async function ativarPush() {
  if (!Sync.enabled()) return toast('Conecte ao PC primeiro (Ler QR do PC)');
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') { renderSettings(); return toast('Sem permissão para notificar'); }
  try {
    const reg = await navigator.serviceWorker.getRegistration('./') || await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(OZ_CONFIG.pushChavePublica) });
    const { endpoint, keys } = sub.toJSON();
    const registro = { endpoint, keys, aparelho: descreverAparelho(), criadoEm: Date.now() };
    await Sync.atualizarInscricao(endpoint, registro);
    gravarJSON(K.push, registro);
    toast('Notificações ativadas neste aparelho');
  } catch (err) {
    toast(`Não foi possível ativar: ${err.message}`);
  }
  renderSettings();
}
async function testarPush() {
  const registro = lerJSON(K.push, null);
  if (!registro) return renderSettings();
  try {
    await Sync.atualizarInscricao(registro.endpoint, { ...registro, testeEm: Date.now() });
    toast('Teste pedido ao PC — chega em até 30 s (com o PC ligado)');
  } catch (err) {
    toast(`Não foi possível pedir o teste: ${err.message}`);
  }
}
async function desativarPush() {
  const registro = lerJSON(K.push, null);
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    if (registro) await Sync.atualizarInscricao(registro.endpoint, null);
  } catch { /* segue desligando localmente */ }
  gravarJSON(K.push, null);
  toast('Notificações desativadas neste aparelho');
  renderSettings();
}

// ---------------------------------------------------------------- celular: QR / link de configuração
// O QR abre o Ofertazera publicado com #config=…; o fragmento (#) não vai a nenhum servidor e é apagado ao ler.
function aplicarLinkConfig(texto) {
  const match = String(texto || '').match(/#config=([\w%-]+)/);
  if (!match) return false;
  try {
    const { token, gistId } = JSON.parse(deBase64url(decodeURIComponent(match[1])));
    if (!token || !gistId) throw new Error();
    Sync.setConfig({ token, gistId });
    toast('Conectado ao PC — carregando ofertas…');
    return true;
  } catch {
    toast('Link de configuração inválido');
    return false;
  }
}
let leitorStream = null;
let jsQrScript;
function pararLeitorQr() {
  leitorStream?.getTracks().forEach((t) => t.stop());
  leitorStream = null;
  const box = $('#leitorQr'); if (box) box.hidden = true;
}
async function lerQr() {
  const video = $('#videoQr');
  try {
    leitorStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return toast('Sem acesso à câmera — permita nas configurações ou cole o link abaixo');
  }
  video.srcObject = leitorStream;
  $('#leitorQr').hidden = false;
  await video.play().catch(() => {});
  let ler;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    ler = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    try {
      jsQrScript ??= carregarScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js').catch((e) => { jsQrScript = null; throw e; });
      await jsQrScript;
    } catch {
      pararLeitorQr();
      return toast('Não foi possível carregar o leitor de QR — cole o link abaixo');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ler = async () => {
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
    };
  }
  while (leitorStream) {
    const texto = await ler().catch(() => null);
    if (texto?.includes('#config=')) {
      pararLeitorQr();
      if (aplicarLinkConfig(texto)) { location.hash = '#/'; carregar(); }
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
let qrScript;
async function mostrarQr() {
  const caixa = $('#qrCodigo');
  if (!caixa.hidden) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  const r = await api('celular');
  if (!r.url) return toast(r.erro || 'Conecte o Gist primeiro');
  try {
    qrScript ??= carregarScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js').catch((e) => { qrScript = null; throw e; });
    await qrScript;
  } catch {
    return toast('Não foi possível carregar o gerador de QR code');
  }
  caixa.innerHTML = '';
  new QRCode(caixa, { text: r.url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  caixa.hidden = false;
}

// ---------------------------------------------------------------- ajustes
function blocoMonitor() {
  const st = S.status;
  const on = monitorando();
  return `<div class="panel">
    <h2>Status do monitor</h2>
    <p>${on ? `🟢 <b>Monitorando</b> o Discord${st?.canal ? ` (${esc(st.canal)})` : ''}. Último sinal ${ago(st.ultimoSinal)}.`
      : `🔴 <b>Parado</b>: abra o canal no Chrome do PC com a extensão Ofertazera ativa.${st?.ultimoSinal ? ` Último sinal ${ago(st.ultimoSinal)}.` : ''}`}
    ${st?.canais?.length ? '<br>' + st.canais.map((c) => `${c.ativo ? '🟢' : '🔴'} #${esc(c.nome)} <span style="opacity:.7">(${c.ativo ? 'ao vivo' : 'parado, ' + ago(c.ultimoSinal)})</span>`).join('<br>') : ''}
    ${!NO_PC && S.publicadoEm ? `<br>Dados do PC de ${ago(S.publicadoEm)}.` : ''}
    <br>${NO_PC && st?.total != null ? st.total : S.ofertas.length} ofertas ${NO_PC ? 'capturadas' : 'recentes'}.</p>
  </div>`;
}
async function renderSettings() {
  pararLeitorQr();
  const versao = `Versão ${typeof OZ_VERSAO === 'number' ? OZ_VERSAO : '?'}${NO_PC ? ' · no PC' : ''}`;
  if (NO_PC) {
    const st = await api('status');
    S.status = st;
    view.innerHTML = `${blocoMonitor()}
    <div class="panel">
      <h2>📱 Celular</h2>
      <p>O celular usa o app publicado (<a class="code" href="${esc(OZ_CONFIG.sitePublico)}" target="_blank">${esc(OZ_CONFIG.sitePublico.replace('https://', ''))}</a>), que lê as ofertas de um <b>Gist secreto</b> do GitHub e recebe as notificações deste PC.</p>
      <p>${st.gist ? `✅ Conectado ao Gist ${esc(st.gist.id.slice(0, 8))}… · token …${esc(st.gist.tokenFim)}` : 'Nenhum Gist conectado: o celular não recebe ofertas nem avisos.'}</p>
      <div class="field"><label>Token do GitHub (só a permissão <b>gist</b> — pode ser o mesmo do FB Radar)</label>
        <div class="row"><input id="token" type="password" placeholder="ghp_… ou github_pat_…" autocomplete="off">
        <button class="btn btn-purple btn-sm" style="flex:0 0 auto" id="conectar">${st.gist ? 'Trocar' : 'Conectar'}</button></div>
      </div>
      <p><a href="https://github.com/settings/tokens/new?scopes=gist&description=Ofertazera" target="_blank" rel="noopener">Criar um token com a permissão gist ↗</a></p>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-orange" id="qr" ${st.gist ? '' : 'disabled'}>Mostrar QR code</button>
        <button class="btn btn-ghost" id="teste" ${st.aparelhos.length ? '' : 'disabled'}>Testar notificação</button>
      </div>
      <div id="qrCodigo" class="qr" hidden></div>
      <p style="margin-top:12px"><b>Aparelhos com notificação (${st.aparelhos.length})</b><br>${st.aparelhos.length ? st.aparelhos.map(esc).join('<br>') : 'Nenhum ainda. No celular: leia o QR → Ajustes → 🔔 Ativar notificações.'}</p>
      ${st.pushPronto ? '' : '<p>⚠️ Push desligado no server.py: falta <span class="code">push_vapid.pem</span> ou a pasta <span class="code">.vendor</span>.</p>'}
    </div>
    <p class="versao">${versao}</p>`;
    $('#conectar').onclick = async () => {
      const token = $('#token').value.trim();
      if (!token) return toast('Cole o token do GitHub');
      const r = await api('gist', { method: 'POST', body: { token } });
      toast(r.ok ? (r.criado ? 'Gist do Ofertazera criado e conectado' : 'Gist do Ofertazera conectado') : `Não foi possível conectar: ${r.erro}`);
      renderSettings();
    };
    $('#qr').onclick = mostrarQr;
    $('#teste').onclick = async () => {
      const r = await api('push-teste', { method: 'POST' });
      toast(r.ok ? `Enviada para ${r.aparelhos} aparelho(s)` : 'Nenhum aparelho recebeu');
    };
    return;
  }

  const inscricao = lerJSON(K.push, null);
  const ativo = Boolean(inscricao) && pushSuportado() && Notification.permission === 'granted';
  const conectado = Sync.enabled();
  const instalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  view.innerHTML = `${conectado ? blocoMonitor() : ''}
  <div class="panel">
    <h2>🔔 Notificações</h2>
    <p>${!pushSuportado() ? '⚠️ Este navegador não suporta notificações. No iPhone, abra o Ofertazera pelo ícone da tela de início (iOS 16.4 ou mais novo).'
      : ativo ? '✅ Notificações ativas neste aparelho. Ofertas dos seus alertas chegam na hora, mesmo com o app fechado.'
        : Notification.permission === 'denied' ? '🚫 Notificações bloqueadas: libere nas configurações do celular/navegador.'
          : 'Notificações desligadas neste aparelho.'}</p>
    <div class="row">
      ${!ativo && pushSuportado() && Notification.permission !== 'denied' ? '<button class="btn btn-orange" id="ativar">🔔 Ativar notificações</button>' : ''}
      ${ativo ? '<button class="btn btn-purple" id="testar">Enviar teste</button><button class="btn btn-ghost" id="desativar">Desativar</button>' : ''}
    </div>
  </div>
  <div class="panel">
    <h2>🔗 Conexão com o PC</h2>
    <p>${conectado ? `✅ Conectado ao Gist ${esc(Sync.config().gistId.slice(0, 8))}…` : 'No PC: Ofertazera → Ajustes → <b>Mostrar QR code</b>. Aqui: leia o QR.'}</p>
    <div class="row"><button class="btn ${conectado ? 'btn-ghost' : 'btn-purple'}" id="lerQr">📷 Ler QR do PC</button></div>
    <div id="leitorQr" class="leitor" hidden><video id="videoQr" playsinline muted></video><button class="btn btn-ghost btn-sm" id="pararQr">Cancelar</button></div>
    <div class="field" style="margin-top:12px"><label>Ou cole o link de configuração</label><input id="linkConfig" placeholder="https://…#config=…"></div>
  </div>
  ${instalado ? '' : `<div class="panel"><h2>📲 Instalar na tela inicial</h2>
    <p>Android (Chrome): menu ⋮ → <b>Instalar app</b>. iPhone (Safari): Compartilhar → <b>Adicionar à Tela de Início</b>, e abra pelo ícone.</p></div>`}
  <p class="versao">${versao}</p>`;
  $('#ativar')?.addEventListener('click', ativarPush);
  $('#testar')?.addEventListener('click', testarPush);
  $('#desativar')?.addEventListener('click', desativarPush);
  $('#lerQr').onclick = lerQr;
  $('#pararQr').onclick = pararLeitorQr;
  $('#linkConfig').onchange = (e) => { if (aplicarLinkConfig(e.target.value)) { location.hash = '#/'; carregar(); } e.target.value = ''; };
}

// ---------------------------------------------------------------- roteador
function rotaAtual() {
  const h = location.hash || '#/';
  const tab = h.startsWith('#/alertas') ? 'alertas' : h.startsWith('#/favoritos') ? 'favoritos' : h.startsWith('#/ajustes') ? 'ajustes' : 'home';
  return { h, tab };
}
function rotear() {
  const { h, tab } = rotaAtual();
  document.querySelectorAll('.bottomnav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (h.startsWith('#/oferta/')) {
    const [id, qs] = h.slice(9).split('?');
    let resumo = null;
    const d = new URLSearchParams(qs || '').get('d');
    if (d) { try { resumo = JSON.parse(deBase64url(d)); } catch { resumo = null; } }
    renderDetail(decodeURIComponent(id), resumo);
    window.scrollTo(0, 0);
    return;
  }
  if (tab === 'alertas') return renderAlerts();
  if (tab === 'ajustes') return renderSettings();
  if (tab === 'favoritos') return renderHome(true);
  renderHome();
}
// Redesenha sem atrapalhar: não mexe em Ajustes/Alertas enquanto o usuário digita
function redesenhar() {
  const { h, tab } = rotaAtual();
  if (tab === 'home' || tab === 'favoritos' || h.startsWith('#/oferta/')) {
    const y = window.scrollY;
    rotear();
    if (!h.startsWith('#/oferta/')) window.scrollTo(0, y);
  }
}

let qTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    S.q = e.target.value.trim();
    if (rotaAtual().tab !== 'home' || location.hash.startsWith('#/oferta/')) location.hash = '#/';
    else renderHome();
  }, 200);
});
window.addEventListener('hashchange', rotear);

// ---------------------------------------------------------------- atualização ao vivo
async function laçoPc() {
  // long-poll: o server.py responde assim que entra uma mensagem nova
  for (;;) {
    try {
      const r = await api('wait?since=' + S.lastIngest);
      if (r.last_ingest > S.lastIngest) { S.lastIngest = r.last_ingest; await carregar(); }
    } catch {
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.tipo === 'push') setTimeout(() => carregar(), 1500); // dá tempo do PC publicar
  if (e.data?.tipo === 'abrir' && e.data.url) location.href = e.data.url;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !NO_PC) carregar(); });
setInterval(() => { if (!document.hidden && !NO_PC) carregar(); }, ATUALIZAR_MS);
setInterval(async () => {
  if (document.hidden) return;
  if (NO_PC) { try { S.status = await api('status'); } catch { /* server.py fora */ } }
  atualizarSelo();
}, 15000);
setInterval(() => { if (!document.hidden) redesenhar(); }, 60000); // "há X min"

// ---------------------------------------------------------------- início
if (location.hash.startsWith('#config=')) {
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  aplicarLinkConfig(hash);
}
if (!NO_PC) {
  // abre na hora com o que já tinha (depois atualiza)
  const cache = lerJSON(K.cache, null);
  if (cache?.ofertas) {
    S.ofertas = cache.ofertas; S.status = cache.status; S.alertas = cache.alertas || S.alertas; S.publicadoEm = cache.ts;
    cache.ofertas.forEach((o) => { S.vistos.add(o.id); S.desenhados.add(o.id); });
  }
}
if ('serviceWorker' in navigator && !NO_PC) navigator.serviceWorker.register('sw.js').catch(() => {});
atualizarSelo();
rotear();
carregar().then(() => { if (NO_PC) laçoPc(); });
