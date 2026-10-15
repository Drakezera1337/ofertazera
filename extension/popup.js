const DEFAULTS = { server: "http://localhost:8787", channels: "848739551295176765, 772928307251118100, 1087857136136093736" };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  $("server").value = cfg.server;
  $("channels").value = cfg.channels;
  $("open").href = cfg.server;
});

$("save").onclick = () => {
  chrome.storage.sync.set({ server: $("server").value.trim(), channels: $("channels").value.trim() }, () => {
    $("save").textContent = "Salvo ✓";
    setTimeout(() => ($("save").textContent = "Salvar"), 1500);
  });
};

chrome.runtime.sendMessage({ type: "getStats" }, (s) => {
  if (!s) { $("st").textContent = "Abra o canal no Discord para começar."; return; }
  const ok = s.lastOk && Date.now() - s.lastOk < 90000;
  $("st").innerHTML = (ok ? "🟢 <b>Conectado ao servidor</b>" : s.lastError ? `🔴 <b>Servidor fora do ar</b><br>${s.lastError}` : "⚪ Aguardando o canal abrir…")
    + `<br>Mensagens enviadas: ${s.sent}`;
});
