// Ofertazera - service worker da extensão.
// 1) Recebe as mensagens do content script e repassa ao servidor local
//    (feito aqui porque o service worker tem permissão para http://localhost).
// 2) Mantém uma aba aberta para cada canal monitorado, todas num grupo "Ofertazera" recolhido.
const SERVIDOR = "771400856372641823"; // servidor do Discord (Guiga Games)
const CANAIS_PADRAO = ["848739551295176765", "772928307251118100", "1087857136136093736"];
const DEFAULTS = { server: "http://localhost:8787", channels: CANAIS_PADRAO.join(", "), abrirAbas: true };
const GRUPO = "Ofertazera";

const stats = { sent: 0, lastOk: 0, lastError: "" };

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "getStats") { reply(stats); return; }
  if (msg.type === "conferirAbas") { conferirAbas().then(() => reply({ ok: true })); return true; }
  if (msg.type !== "ingest" && msg.type !== "heartbeat") return;
  (async () => {
    const cfg = await chrome.storage.sync.get(DEFAULTS);
    const url = cfg.server.replace(/\/$/, "") + (msg.type === "ingest" ? "/api/ingest" : "/api/heartbeat");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.payload),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (msg.type === "ingest") stats.sent += msg.payload.messages.length;
      stats.lastOk = Date.now(); stats.lastError = "";
      reply({ ok: true });
    } catch (e) {
      stats.lastError = String(e.message || e);
      reply({ ok: false, error: stats.lastError });
    }
  })();
  return true; // resposta assíncrona
});

// ---------------------------------------------------------------- abas dos canais
// Cada item do popup pode ser só o ID do canal ou o link inteiro do canal.
function canaisConfigurados(texto) {
  const lista = [...CANAIS_PADRAO.map((c) => ({ servidor: SERVIDOR, canal: c }))];
  for (const item of String(texto || "").split(/[\s,]+/).filter(Boolean)) {
    const m = item.match(/channels\/(\d+)\/(\d+)/) || item.match(/^()(\d{15,})$/);
    if (m && !lista.some((c) => c.canal === m[2])) lista.push({ servidor: m[1] || SERVIDOR, canal: m[2] });
  }
  return lista;
}
const canalDaUrl = (url) => (String(url || "").match(/discord\.com\/channels\/[^/]+\/(\d+)/) || [])[1];

let conferindo = false;
async function conferirAbas() {
  if (conferindo) return;
  conferindo = true;
  try {
    const cfg = await chrome.storage.sync.get(DEFAULTS);
    if (!cfg.abrirAbas) return;
    const janela = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    if (!janela) return; // Chrome sem janela aberta: confere de novo no próximo minuto
    const abas = await chrome.tabs.query({ url: ["https://discord.com/channels/*", "https://*.discord.com/channels/*"] });
    const doGrupo = [];

    for (const { servidor, canal } of canaisConfigurados(cfg.channels)) {
      let aba = abas.find((a) => canalDaUrl(a.url || a.pendingUrl) === canal);
      if (!aba) {
        aba = await chrome.tabs.create({ windowId: janela.id, url: `https://discord.com/channels/${servidor}/${canal}`, active: false });
      } else if (aba.discarded) {
        await chrome.tabs.reload(aba.id); // aba descartada pelo Chrome não roda o leitor
      }
      // Impede o Chrome de descartar a aba para economizar memória
      chrome.tabs.update(aba.id, { autoDiscardable: false }).catch(() => {});
      doGrupo.push(aba);
    }
    if (doGrupo.length) await agrupar(doGrupo);
  } catch (e) {
    console.warn("[Ofertazera] abas:", e);
  } finally {
    conferindo = false;
  }
}

async function agrupar(abas) {
  const porJanela = new Map();
  abas.forEach((a) => porJanela.set(a.windowId, [...(porJanela.get(a.windowId) || []), a]));
  for (const [windowId, lista] of porJanela) {
    const [existente] = await chrome.tabGroups.query({ windowId, title: GRUPO });
    const soltas = lista.filter((a) => !existente || a.groupId !== existente.id).map((a) => a.id);
    if (!soltas.length && existente?.collapsed) continue;
    const groupId = soltas.length
      ? await chrome.tabs.group(existente ? { groupId: existente.id, tabIds: soltas } : { tabIds: soltas, createProperties: { windowId } })
      : existente.id;
    // Você está olhando uma aba do grupo: não recolhe agora (o Chrome trocaria de aba); recolhe na próxima conferência
    const vendo = (await chrome.tabs.query({ groupId, active: true })).length > 0;
    await chrome.tabGroups.update(groupId, { title: GRUPO, color: "purple", ...(vendo ? {} : { collapsed: true }) }).catch(() => {});
  }
}

// Quando confere: ao abrir o Chrome, ao instalar/atualizar, a cada minuto e logo após fechar uma aba
chrome.runtime.onStartup.addListener(() => setTimeout(conferirAbas, 3000));
chrome.runtime.onInstalled.addListener(async () => {
  // Abas do Discord abertas antes da instalação não têm o leitor: recarrega as dos canais monitorados
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  const canais = canaisConfigurados(cfg.channels).map((c) => c.canal);
  const abas = await chrome.tabs.query({ url: ["https://discord.com/channels/*"] });
  abas.filter((a) => canais.includes(canalDaUrl(a.url))).forEach((a) => chrome.tabs.reload(a.id));
  setTimeout(conferirAbas, 2000);
});
chrome.alarms.create("conferirAbas", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "conferirAbas") conferirAbas(); });
chrome.tabs.onRemoved.addListener(() => setTimeout(conferirAbas, 5000));
chrome.windows.onCreated.addListener(() => setTimeout(conferirAbas, 3000));
chrome.storage.onChanged.addListener((ch) => { if (ch.channels || ch.abrirAbas) conferirAbas(); });
