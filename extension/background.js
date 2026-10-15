// Recebe as mensagens do content script e repassa ao servidor local.
// (Feito aqui porque o service worker tem permissão para http://localhost.)
const DEFAULTS = { server: "http://localhost:8787", channels: "848739551295176765" };

const stats = { sent: 0, lastOk: 0, lastError: "" };

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "getStats") { reply(stats); return; }
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
