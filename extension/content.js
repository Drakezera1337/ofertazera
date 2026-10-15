// Ofertazera - lê as mensagens que aparecem na tela do canal monitorado.
// Não usa token nem API do Discord: apenas observa a página que você já tem aberta.
(() => {
  const DEFAULTS = { server: "http://localhost:8787", channels: "848739551295176765" };
  let watched = new Set(DEFAULTS.channels.split(/[\s,]+/));
  const sentSig = new Map(); // id -> assinatura do conteúdo já enviado
  let scanTimer = null;

  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    watched = new Set(cfg.channels.split(/[\s,]+/).filter(Boolean));
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.channels) watched = new Set(ch.channels.newValue.split(/[\s,]+/).filter(Boolean));
  });

  function currentChannel() {
    const m = location.pathname.match(/^\/channels\/(\d+|@me)\/(\d+)/);
    return m && watched.has(m[2]) ? m[2] : null;
  }

  // Timestamp exato a partir do ID (snowflake) do Discord
  function snowflakeTime(id) {
    try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch (e) { return Date.now(); }
  }

  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
    } catch (e) {
      // extensão recarregada: esta aba precisa de F5
      console.warn("[Ofertazera] recarregue a aba do Discord (F5)");
    }
  }

  const BAD_IMG = /avatar|emoji|embedAuthorIcon|embedFooterIcon|reaction|sticker|roleIcon|clanTag|badge/i;

  function fullImage(src) {
    try {
      const u = new URL(src, location.href);
      if (/^(media|images-ext-\d)\.discordapp\.net$/.test(u.hostname)) { u.searchParams.delete("width"); u.searchParams.delete("height"); }
      return u.toString();
    } catch (e) { return src; }
  }

  function parseMessage(li, lastAuthor) {
    const id = li.id.split("-").pop();
    if (!/^\d{15,}$/.test(id)) return null;
    const content = li.querySelector(`[id="message-content-${id}"]`);
    const accessories = li.querySelector(`[id="message-accessories-${id}"]`);
    const authorEl = li.querySelector('[id^="message-username-"] [class*="username"], h3 [class*="username"]');
    const author = authorEl ? authorEl.textContent.trim() : lastAuthor;

    let text = content ? content.innerText : "";
    text = text.replace(/\s*\((editad[oa]|edited)\)\s*$/i, "").trim();

    // texto dos embeds (título, descrição, campos) — muitos bots postam assim
    if (accessories) {
      accessories.querySelectorAll('article, [class*="embedWrapper"]').forEach((emb) => {
        const t = emb.innerText.trim();
        if (t && !text.includes(t)) text += (text ? "\n\n" : "") + t;
      });
    }

    const links = [];
    [content, accessories].forEach((root) => {
      if (!root) return;
      root.querySelectorAll("a[href]").forEach((a) => {
        const h = a.href;
        if (/^https?:/.test(h) && !/discord\.(com|gg)\/(channels|invite)|cdn\.discordapp|media\.discordapp/.test(h) && !links.includes(h)) links.push(h);
      });
    });

    const codes = content ? [...content.querySelectorAll("code")].map((c) => c.textContent.trim()) : [];

    const images = [];
    if (accessories) {
      accessories.querySelectorAll("img").forEach((img) => {
        const cls = (img.className || "") + " " + (img.parentElement?.className || "");
        if (BAD_IMG.test(cls) || !img.src || img.src.startsWith("data:")) return;
        if ((img.naturalWidth && img.naturalWidth < 48) || img.width && img.width < 40) return;
        const src = fullImage(img.src);
        if (!images.includes(src)) images.push(src);
      });
    }

    if (!text && !images.length) return null;
    return { id, channel: currentChannel(), author, text, links, codes, images, timestamp: snowflakeTime(id) };
  }

  function scan() {
    scanTimer = null;
    if (!currentChannel()) return;
    const items = document.querySelectorAll('li[id^="chat-messages-"]');
    const batch = [];
    let lastAuthor = null;
    items.forEach((li) => {
      const m = parseMessage(li, lastAuthor);
      if (!m) return;
      lastAuthor = m.author;
      const sig = m.text.length + "|" + m.images.join(",") + "|" + m.links.length;
      if (sentSig.get(m.id) === sig) return;
      sentSig.set(m.id, sig);
      batch.push(m);
    });
    if (batch.length) {
      send("ingest", { messages: batch });
      console.log(`[Ofertazera] enviadas ${batch.length} mensagem(ns)`);
    }
  }

  function schedule() {
    if (!scanTimer) scanTimer = setTimeout(scan, 300);
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });

  function heartbeat() {
    if (!currentChannel()) return;
    const header = document.querySelector('section[class*="title"] h1, [class*="titleWrapper"] h1, h1[class*="title"]');
    const name = (header && header.textContent.trim()) || (document.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*Discord.*$/, "");
    send("heartbeat", { channelName: name, url: location.href, visible: document.visibilityState });
  }
  setInterval(heartbeat, 30000);
  setInterval(scan, 5000); // rede de segurança caso algum evento passe
  setTimeout(() => { heartbeat(); scan(); }, 2000);
})();
