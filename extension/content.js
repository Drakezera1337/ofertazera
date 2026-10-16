// Ofertazera - lê as mensagens que aparecem na tela do canal monitorado.
// Não usa token nem API do Discord: apenas observa a página que você já tem aberta.
(() => {
  // Canais monitorados sempre (os do popup somam a estes). Cada um precisa estar aberto numa aba.
  const CANAIS_PADRAO = ["848739551295176765", "772928307251118100", "1087857136136093736"];
  const DEFAULTS = { server: "http://localhost:8787", channels: CANAIS_PADRAO.join(", ") };
  // Aceita o ID do canal ou o link inteiro (https://discord.com/channels/<servidor>/<canal>)
  const lerCanais = (txt) => new Set([...CANAIS_PADRAO, ...String(txt || "").split(/[\s,]+/)
    .map((item) => (item.match(/(\d{15,})\/?$/) || [])[1]).filter(Boolean)]);
  let watched = lerCanais("");
  const sentSig = new Map(); // id -> assinatura do conteúdo já enviado
  let scanTimer = null;

  chrome.storage.sync.get(DEFAULTS, (cfg) => { watched = lerCanais(cfg.channels); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.channels) watched = lerCanais(ch.channels.newValue);
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

  // li#chat-messages-<canal>-<mensagem>
  function parseMessage(li, lastAuthor) {
    const [, channel, id] = li.id.match(/^chat-messages-(\d+)-(\d+)$/) || [];
    if (!id || !watched.has(channel)) return null;
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

    const images = coletarImagens(accessories || li);
    // Tem anexo/prévia mas nenhuma imagem achada: manda um resumo da estrutura para o server.log
    const diag = !images.length && accessories && accessories.childElementCount ? esqueleto(accessories) : undefined;

    if (!text && !images.length) return null;
    return { id, channel, author, text, links, codes, images, diag, timestamp: snowflakeTime(id) };
  }

  // Imagens do anexo/prévia: <img>, capa de vídeo/GIF, link direto de imagem e imagem de fundo.
  // Não descarta imagem ainda não carregada (as abas ficam no grupo recolhido, fora da tela).
  function coletarImagens(root) {
    const urls = [];
    const add = (u) => {
      if (!u || !/^https?:/.test(u) || /\/emojis\/|\/avatars\/|\/stickers\//.test(u)) return;
      const f = fullImage(u);
      if (!urls.includes(f)) urls.push(f);
    };
    root.querySelectorAll("img").forEach((img) => {
      const cls = (img.className || "") + " " + (img.parentElement?.className || "");
      if (BAD_IMG.test(cls) || img.closest('[class*="avatar"], [class*="reactions"], [class*="repliedMessage"]')) return;
      if (img.complete && img.naturalWidth && img.naturalWidth < 48) return; // ícone pequeno
      add(img.currentSrc || img.src || img.dataset.src);
    });
    root.querySelectorAll("video").forEach((v) => add(v.poster || v.querySelector("source")?.src));
    root.querySelectorAll("a[href]").forEach((a) => {
      if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.href) || /(media|images-ext-\d)\.discordapp\.net|cdn\.discordapp\.com\/attachments/.test(a.href)) add(a.href);
    });
    root.querySelectorAll('[style*="background-image"]').forEach((el) => {
      add((el.style.backgroundImage.match(/url\(["']?([^"')]+)/) || [])[1]);
    });
    return urls;
  }

  // Resumo da estrutura (tags, classes e hosts das URLs) para descobrir onde o Discord pôs a imagem
  function esqueleto(el, nivel = 0) {
    if (nivel > 7) return "";
    const cls = String(el.className || "").split(/\s+/).filter(Boolean).map((c) => c.split("_")[0]).slice(0, 2).join(".");
    const url = el.getAttribute("src") || el.getAttribute("href") || el.getAttribute("poster") || "";
    let s = `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${url ? `[${url.slice(0, 60)}]` : ""}`;
    const filhos = [...el.children].slice(0, 6).map((c) => esqueleto(c, nivel + 1)).filter(Boolean);
    if (filhos.length) s += `{${filhos.join(" ")}}`;
    return s.slice(0, 1500);
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

  // Título da aba: "Discord | #🎮 | consoles | Servidor" -> "consoles"
  function nomeDoCanal() {
    const partes = (document.title || "").replace(/^\(\d+\)\s*/, "").split(" | ")
      .map((p) => p.replace(/^#/, "").trim()).filter((p) => p && p !== "Discord");
    if (partes.length > 1) partes.pop(); // nome do servidor
    const comLetras = partes.filter((p) => /[\p{L}\p{N}]/u.test(p));
    // "💸│placa-vídeo" -> "placa-vídeo"
    return (comLetras.join(" ") || partes.join(" ")).replace(/^[^\p{L}\p{N}]+/u, "");
  }
  function heartbeat() {
    const channel = currentChannel();
    if (!channel) return;
    pedir("heartbeat", { channel, channelName: nomeDoCanal(), url: location.href, visible: document.visibilityState })
      .then((r) => {
        // servidor ficou fora: recupera o buraco (no máximo uma tentativa a cada 10 min)
        if (r && r.recuperar) recuperarPerdidas();
      });
  }
  // ------------------------------------------------------------ mensagens perdidas (PC desligado)
  // Ao abrir o canal, o Discord só mostra as mensagens mais recentes. Se o servidor ainda não tem
  // as anteriores (chegaram com o PC desligado), rola o histórico para cima, lendo tudo, até
  // encontrar a última mensagem que o servidor já conhece; depois volta para o fim (ao vivo).
  const pedir = (type, payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (r) => { void chrome.runtime.lastError; resolve(r); });
    } catch (e) { resolve(null); }
  });
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const idsNaTela = () => [...document.querySelectorAll('li[id^="chat-messages-"]')]
    .map((li) => (li.id.match(/-(\d+)$/) || [])[1]).filter(Boolean).map((id) => BigInt(id));
  const rolagem = () => document.querySelector('[data-list-id="chat-messages"]')?.closest('[class*="scroller"]');

  let recuperando = false;
  // guardado na aba: a página recarrega depois de recuperar e não pode tentar de novo em seguida
  let ultimaTentativa = Number(sessionStorage.getItem("ofertazera:tentativa") || 0);
  async function recuperarPerdidas() {
    const canal = currentChannel();
    if (!canal || recuperando) return;
    if (Date.now() - ultimaTentativa < 10 * 60_000) return; // tentou há pouco
    recuperando = true;
    ultimaTentativa = Date.now();
    sessionStorage.setItem("ofertazera:tentativa", String(ultimaTentativa));
    let rolou = false;
    try {
      // "antes desta página abrir": as mensagens que a página acabou de mandar não contam
      const r = await pedir("ultima", { channel: canal, antesDe: Math.round(performance.timeOrigin) });
      if (!r || !r.ok) {
        // servidor ainda subindo (Chrome abriu antes dele no boot): tenta de novo em 30 s
        ultimaTentativa = 0;
        sessionStorage.removeItem("ofertazera:tentativa");
        setTimeout(recuperarPerdidas, 30000);
        return;
      }
      if (!r.ultima) return; // canal novo para o servidor: as mensagens da tela bastam
      const ultima = BigInt(r.ultima);
      let antes = null, parado = 0, concluiu = false;
      const vistas = new Set();
      for (let i = 0; i < 80; i++) {          // até ~2 min rolando
        scan();
        const ids = idsNaTela();
        ids.forEach((id) => vistas.add(id));
        if (!ids.length) { await esperar(1500); continue; }
        const maisVelha = ids.reduce((a, b) => (a < b ? a : b));
        if (maisVelha <= ultima) { concluiu = true; break; }  // chegou no que o servidor já tem
        if (maisVelha === antes && ++parado >= 4) { concluiu = true; break; } // começo do canal
        if (maisVelha !== antes) parado = 0;
        antes = maisVelha;
        const el = rolagem();
        if (!el) break;
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
        rolou = true;
        await esperar(1500);
      }
      scan();
      if (concluiu) send("recuperado", { channel: canal, lidas: vistas.size });
      console.log(`[Ofertazera] período desligado: ${vistas.size} mensagens conferidas${concluiu ? "" : " (incompleto)"}`);
    } finally {
      recuperando = false;
    }
    if (!rolou) return;
    // Volta para o fim do canal (ao vivo). Rolar de volta não basta: o Discord fica "preso" no
    // histórico e as mensagens novas não aparecem. Recarregar abre sempre no presente.
    await esperar(1500); // dá tempo da última leva chegar ao servidor
    location.reload();
  }

  // Proteção: aba monitorada em segundo plano mostrando mensagens antigas (barra "ir para o presente")
  // não vê as novas; volta sozinha para o presente.
  function presoNoPassado() {
    return [...document.querySelectorAll("button, [role=button], [class*='jumpToPresent']")]
      .some((b) => /pular para o presente|ir para o presente|jump to present|mensagens mais recentes|newer messages/i.test(b.textContent || ""));
  }
  setInterval(() => {
    if (recuperando || !document.hidden || !currentChannel()) return;
    if (presoNoPassado()) {
      console.log("[Ofertazera] aba presa em mensagens antigas: voltando ao presente");
      location.reload();
    }
  }, 60_000);

  setInterval(heartbeat, 30000);
  setInterval(scan, 5000); // rede de segurança caso algum evento passe
  setTimeout(() => { heartbeat(); scan(); }, 2000);
  setTimeout(recuperarPerdidas, 6000); // depois do Discord carregar as mensagens recentes
})();
