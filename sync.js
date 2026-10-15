// Gist secreto do Ofertazera. A API do GitHub aceita chamadas direto do navegador (CORS),
// então funciona no GitHub Pages. Só o celular usa isto (no PC o app fala com o server.py).
//
// Arquivos no Gist:
//   ofertas.json  ofertas publicadas pelo server.py do PC (o celular lê daqui)
//   alertas.json  alertas (o celular e o PC gravam; o ts maior vale)
//   push.json     aparelhos inscritos para notificações (o server.py do PC envia)
const Sync = (() => {
  const CFG_KEY = 'ofertazera:sync';
  const API = 'https://api.github.com/gists';

  function config() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
  }
  function setConfig(cfg) {
    if (cfg) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CFG_KEY);
  }
  function enabled() {
    const c = config();
    return Boolean(c.token && c.gistId);
  }

  async function request(url, { method = 'GET', body } = {}) {
    const { token } = config();
    const res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = res.status === 401 ? 'token inválido' : res.status === 404 ? 'Gist não encontrado'
        : res.status === 403 ? 'acesso negado pelo GitHub (403)' : `erro ${res.status}`;
      throw new Error(msg);
    }
    return res.json();
  }

  async function lerArquivo(gist, nome, padrao) {
    const file = gist.files && gist.files[nome];
    if (!file) return padrao;
    let content = file.content;
    if (file.truncated) content = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
    try { return JSON.parse(content || 'null') ?? padrao; } catch { return padrao; }
  }

  // Lê vários arquivos numa chamada só: { 'ofertas.json': padrão, ... }
  async function ler(nomes) {
    const gist = await request(`${API}/${config().gistId}`);
    const saida = {};
    for (const [nome, padrao] of Object.entries(nomes)) saida[nome] = await lerArquivo(gist, nome, padrao);
    return saida;
  }

  async function gravar(nome, valor) {
    await request(`${API}/${config().gistId}`, {
      method: 'PATCH',
      body: { files: { [nome]: { content: JSON.stringify(valor, null, 1) } } },
    });
  }

  // Aparelhos que recebem notificações: novo = null remove o aparelho
  async function atualizarInscricao(endpoint, novo) {
    const { 'push.json': lista } = await ler({ 'push.json': [] });
    const resto = (Array.isArray(lista) ? lista : []).filter((r) => r && r.endpoint !== endpoint);
    if (novo) resto.push(novo);
    await gravar('push.json', resto);
  }

  return { config, setConfig, enabled, ler, gravar, atualizarInscricao };
})();
