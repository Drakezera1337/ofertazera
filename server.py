"""
Ofertazera - servidor local.

Recebe as mensagens capturadas pela extensao do Chrome (aba do Discord aberta),
extrai preco/cupom/loja/link, guarda em SQLite e serve o app no PC (localhost).
Para o celular (app publicado no GitHub Pages), publica as ofertas num Gist secreto
e envia notificacoes Web Push (VAPID) na hora em que uma oferta bate com seus alertas
- o mesmo esquema do Rastreazera / FB Radar.

Rode:  python server.py   (pywebpush fica em .vendor/, a chave privada em push_vapid.pem)
"""
import html
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("OFERTAZERA_PORT", "8787"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "ofertazera.db")

# Minutos sem sinal da extensao antes de avisar no celular que o monitor parou.
HEARTBEAT_ALERT_MIN = 3

# --------------------------------------------------------------------------- #
# Banco de dados
# --------------------------------------------------------------------------- #
_db_lock = threading.Lock()
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.row_factory = sqlite3.Row
_db.executescript(
    """
    CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY,
        channel TEXT,
        author TEXT,
        posted_at INTEGER,
        received_at INTEGER,
        text TEXT,
        title TEXT,
        price REAL,
        old_price REAL,
        coupon TEXT,
        link TEXT,
        store TEXT,
        image TEXT,
        links TEXT,
        images TEXT,
        matched TEXT,
        notified INTEGER DEFAULT 0,
        fav INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_offers_posted ON offers(posted_at DESC);
    CREATE TABLE IF NOT EXISTS interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        query TEXT,
        max_price REAL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    """
)
for _col in ("coupon_note TEXT", "coupon_link TEXT", "final_url TEXT", "coupons TEXT",
             "og_image TEXT", "enriquecido INTEGER DEFAULT 0"):
    try:
        _db.execute(f"ALTER TABLE offers ADD COLUMN {_col}")
    except sqlite3.OperationalError:
        pass  # coluna ja existe


def db_exec(sql, params=()):
    with _db_lock:
        cur = _db.execute(sql, params)
        _db.commit()
        return cur


def db_all(sql, params=()):
    with _db_lock:
        return [dict(r) for r in _db.execute(sql, params).fetchall()]


def db_one(sql, params=()):
    rows = db_all(sql, params)
    return rows[0] if rows else None


DEFAULT_SETTINGS = {
    "notify_all": "0",
    "gist_token": "",
    "gist_id": "",
    "alertas_ts": "0",
}


def get_setting(key):
    row = db_one("SELECT value FROM settings WHERE key=?", (key,))
    if row is None:
        value = DEFAULT_SETTINGS.get(key, "")
        db_exec("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (key, value))
        return value
    return row["value"]


def set_setting(key, value):
    db_exec("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, str(value)))


for _k in DEFAULT_SETTINGS:
    get_setting(_k)

# --------------------------------------------------------------------------- #
# Parser das mensagens
# --------------------------------------------------------------------------- #
STORES = [
    (("amazon.", "amzn.to", "amzn."), "Amazon"),
    (("mercadolivre", "mercadolibre", "meli.la"), "Mercado Livre"),
    (("kabum",), "KaBuM!"),
    (("magazineluiza", "magalu", "mgl.io"), "Magalu"),
    (("shopee", "shp.ee"), "Shopee"),
    (("aliexpress", "s.click.ali", "a.aliexpress"), "AliExpress"),
    (("casasbahia",), "Casas Bahia"),
    (("pontofrio",), "Ponto"),
    (("extra.com",), "Extra"),
    (("americanas",), "Americanas"),
    (("submarino",), "Submarino"),
    (("pichau",), "Pichau"),
    (("terabyteshop",), "Terabyte"),
    (("fastshop",), "Fast Shop"),
    (("carrefour",), "Carrefour"),
    (("girafa",), "Girafa"),
    (("nuuvem",), "Nuuvem"),
    (("playstation.com", "store.playstation"), "PlayStation Store"),
    (("xbox.com", "microsoft.com"), "Microsoft"),
    (("nintendo.com",), "Nintendo"),
    (("steampowered", "steam"), "Steam"),
    (("epicgames",), "Epic Games"),
]

PRICE_RE = re.compile(r"R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)", re.I)
DE_POR_RE = re.compile(
    r"de\s*:?\s*~*R\$\s*([\d.,]+)~*.{0,40}?por\s*:?\s*R\$\s*([\d.,]+)", re.I | re.S
)
COUPON_RE = re.compile(
    r"cup[oó]m(?:\s+de\s+desconto)?\s*[:\-–=>]*\s*[`\"'*_]*([A-Za-z0-9][A-Za-z0-9_\-]{2,24})",
    re.I,
)
COUPON_STOPWORDS = {
    "de", "do", "da", "no", "na", "nao", "sem", "com", "aplicado", "aplicada", "automatico",
    "automatica", "desconto", "disponivel", "valido", "ativo", "esgotado", "pagina", "site",
    "app", "link", "abaixo", "acima", "aqui", "loja", "ml", "na_pagina", "exclusivo",
    "para", "pra", "e", "ou", "off", "ate", "nos", "nas", "seu", "sua",
}
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF←-⇿"
    "⌀-⏿⬀-⯿️‍⃣]+"
)
URL_RE = re.compile(r"https?://\S+")


def normalize(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def parse_brl(value):
    value = value.strip().rstrip(".,")
    if "," in value:
        value = value.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", value):
        value = value.replace(".", "")
    try:
        return float(value)
    except ValueError:
        return None


SHORTENERS = ("tidd.ly", "bit.ly", "tinyurl.com", "cutt.ly", "is.gd", "rebrand.ly", "t.co",
              "encurtador", "linktr.ee", "short", "abre.ai", "oferta.vc", "app.link", "onelink")


def is_shortener(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return any(s in host for s in SHORTENERS)


def detect_store(urls):
    for url in urls:
        host = normalize(urllib.parse.urlparse(url).hostname or url)
        for keys, name in STORES:
            if any(k in host for k in keys):
                return name
    for url in urls:
        if is_shortener(url):
            continue
        host = (urllib.parse.urlparse(url).hostname or "").replace("www.", "")
        parts = host.split(".")
        if parts and parts[0]:
            return parts[0].capitalize()
    return None


NAVEGADOR = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Accept": "text/html,application/xhtml+xml",
}
OG_IMAGE_RE = re.compile(
    r"""<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)"""
    r"""|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']""", re.I)
# Lojas cuja pagina nao traz a foto no HTML (montada por JavaScript): nem tenta
SEM_FOTO_NO_HTML = ("shopee",)


def buscar_pagina(url):
    """Abre o link da oferta (seguindo encurtadores como tidd.ly) e devolve (url_final, foto_do_produto)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=NAVEGADOR), timeout=8) as r:
            final = r.geturl()
            if any(s in (urllib.parse.urlparse(final).hostname or "") for s in SEM_FOTO_NO_HTML):
                return final, None
            pagina = r.read(800_000).decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:  # 403/405: ainda assim pode ter a url final
        return (e.url if e.url and e.url != url else None), None
    except Exception:  # noqa: BLE001
        return None, None
    m = OG_IMAGE_RE.search(pagina)
    foto = html.unescape(m.group(1) or m.group(2)).strip() if m else None
    if foto and foto.startswith("//"):
        foto = "https:" + foto
    elif foto and foto.startswith("/"):
        foto = urllib.parse.urljoin(final, foto)
    return final, (foto if foto and foto.startswith("http") else None)


def imagem_original(url):
    """Prévia do Discord (images-ext-N.discordapp.net/external/<hash>/https/host/arquivo) -> link original.
    O link do proxy do Discord expira; o original (ex.: servidor de imagens da Shopee) não."""
    m = re.match(r"https?://images-ext-\d+\.discordapp\.net/external/[^/]+/(https?)/(.+)", url or "")
    if not m:
        return url
    caminho = urllib.parse.unquote(m.group(2).split("?", 1)[0])
    return f"{m.group(1)}://{caminho}"


def clean_line(line):
    line = URL_RE.sub("", line)
    line = EMOJI_RE.sub("", line)
    line = re.sub(r"<a?:\w+:\d+>|:[a-z0-9_]+:", "", line)  # emojis customizados
    line = re.sub(r"[*_~`>|#]+", "", line)
    line = re.sub(r"@\S+", "", line)
    return re.sub(r"\s+", " ", line).strip(" -–•:")


def make_title(text):
    for raw in (text or "").splitlines():
        if raw.strip().startswith("@"):  # mencao de cargo (@Video-Game, @Placa de video)
            continue
        line = clean_line(raw)
        if len(line) < 4:
            continue
        low = normalize(line)
        if re.fullmatch(r"(r\$\s*[\d.,]+\s*)+", low):
            continue
        if re.fullmatch(r"cupom\s*:?\s*\S+", low):  # "Cupom: CODIGO" sozinho
            continue
        if low.startswith(("link", "compre", "de r$", "por r$", "preco", "frete", "resgate", "ative")):
            continue
        return line[:140]
    # So sobrou a linha da mencao: "@Placa de vídeo RX 9070 GRE" (mencao e produto na mesma linha)
    for raw in (text or "").splitlines():
        line = clean_line(raw.strip().lstrip("@"))
        if raw.strip().startswith("@") and len(line) > 15:
            return line[:140]
    return clean_line(text or "")[:140] or "Oferta"


def parse_offer(msg):
    text = msg.get("text") or ""
    codes = [c.strip() for c in msg.get("codes") or [] if c and c.strip()]
    links = [l for l in msg.get("links") or [] if l.startswith("http")]
    links += [u.rstrip(").,>") for u in URL_RE.findall(text) if u.rstrip(").,>") not in links]
    links = [l for l in links if "discord.com" not in l and "discord.gg" not in l]

    price = old_price = None
    m = DE_POR_RE.search(text)
    if m:
        old_price, price = parse_brl(m.group(1)), parse_brl(m.group(2))
    if price is None:
        found = []
        for pm in PRICE_RE.finditer(text):
            antes = normalize(text[max(0, pm.start() - 16):pm.start()]).rstrip(" :~*")
            depois = normalize(text[pm.end():pm.end() + 6]).lstrip(" ~*")
            if depois.startswith("off") or re.search(r"(acima de|\bem|limite(?: de)?|minimo(?: de)?|\bate|compras de)$", antes):
                continue  # regra do cupom, nao e o preco do produto
            v = parse_brl(pm.group(1))
            if v:
                found.append(v)
        # mensagens costumam vir "~~R$ 4.199~~ R$ 3.499": preco riscado primeiro
        strike = re.search(r"~~[^~]*R\$\s*([\d.,]+)[^~]*~~", text)
        if strike:
            old_price = parse_brl(strike.group(1))
            found = [p for p in found if p != old_price] or found
        if found:
            low_text = normalize(text)
            idx = low_text.find("por r$")
            price = found[0]
            if idx >= 0:
                after = PRICE_RE.search(text[idx:])
                if after:
                    price = parse_brl(after.group(1))
    if old_price is not None and price is not None and old_price <= price:
        old_price = None

    def codigo_ok(c):
        # "TORCEDOR10", "PLAY10", "promo10" sim; "Mercado", "Shopee" (nome da loja) nao
        return (re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_\-]{2,24}", c) and normalize(c) not in COUPON_STOPWORDS
                and (c.isupper() or re.search(r"\d", c)) and re.search(r"[A-Za-z]", c))
    coupons = []
    candidatos = [cm.group(1).strip("`*_\"'") for cm in COUPON_RE.finditer(text)]
    # "5% OFF acima de R$ 79, limite R$ 30: TORCEDOR10" -> codigo no fim da linha, depois de ":"
    candidatos += [m.group(1) for m in re.finditer(r":\s*[`*_\"']*([A-Z][A-Z0-9_\-]{3,24})[`*_\"']*\s*$", text, re.M)]
    candidatos += [c for c in codes if not c.startswith("http")]
    for c in candidatos:
        if codigo_ok(c) and c not in coupons:
            coupons.append(c)
    coupon = coupons[0] if coupons else None

    product_link, coupon_link = classify_links(text, links)

    # "Resgate cupom R$ 90/100 OFF aqui" / "Resgate todos os cupons desta pagina"
    coupon_note = None
    if not coupon:
        nm = re.search(r"cupo(?:m|ns)[^\n]*?(R\$\s*[\d.,]+(?:\s*/\s*[\d.,]+)?\s*(?:OFF)?|\d+\s*%\s*(?:OFF)?)", text, re.I)
        if nm:
            coupon_note = "Cupom " + re.sub(r"\s+", " ", nm.group(1)).strip()
        elif re.search(r"cupo(?:m|ns)", text, re.I) and not re.search(r"sem\s+cupom", text, re.I):
            coupon_note = "Cupons na página"

    images = []
    for i in msg.get("images") or []:
        i = imagem_original(i)
        if i and i not in images:
            images.append(i)
    return {
        "title": make_title(text),
        "price": price,
        "old_price": old_price,
        "coupon": coupon,
        "coupons": coupons,
        "coupon_note": coupon_note,
        "link": product_link,
        "coupon_link": coupon_link,
        "store": detect_store(links),
        "image": images[0] if images else None,
        "links": links,
        "images": images,
    }


def classify_links(text, links):
    """Separa o link do produto do link de 'resgatar cupons', pelo rotulo que vem antes."""
    product = coupon = None
    first_free = None
    label = ""
    for raw in (text or "").splitlines():
        urls = [u.rstrip(").,>") for u in URL_RE.findall(raw)]
        before = normalize(URL_RE.sub("", raw)).strip()
        if not urls:
            if before:
                label = before
            continue
        ctx = before or label
        for u in urls:
            if "discord" in u:
                continue
            if "produto" in ctx or "product" in ctx:
                product = product or u
            elif "cupo" in ctx or "resgat" in ctx:
                coupon = coupon or u
            else:
                first_free = first_free or u
        label = ""
    product = product or first_free or (links[0] if links and links[0] != coupon else None)
    if product is None and coupon:  # so tem o link dos cupons
        product, coupon = coupon, None
    return product, coupon


# --------------------------------------------------------------------------- #
# Alertas (interesses)
# --------------------------------------------------------------------------- #
def interest_matches(interest, offer):
    """query: virgula separa alternativas; espacos = todas as palavras; -palavra exclui.
    Ex.: "ps5, playstation 5 -controle -jogo"."""
    haystack = normalize(offer.get("title", "") + " " + offer.get("text", ""))
    haystack = re.sub(r"[^a-z0-9$.,\s]", " ", haystack)
    words_in = set(haystack.split())
    joined = " " + " ".join(haystack.split()) + " "

    def has(term):
        term = normalize(term).strip()
        if not term:
            return True
        if " " in term:
            return (" " + term + " ") in joined
        return term in words_in or (len(term) >= 4 and term in joined)

    query = interest.get("query") or interest.get("name") or ""
    excludes = [w[1:] for w in query.split() if w.startswith("-") and len(w) > 1]
    if any(has(e) for e in excludes):
        return False
    positive = " ".join(w for w in query.split() if not w.startswith("-"))
    alternatives = [a.strip() for a in positive.split(",") if a.strip()]
    if not alternatives:
        return False
    ok = any(all(has(t) for t in alt.split()) for alt in alternatives)
    if not ok:
        return False
    max_price = interest.get("max_price")
    if max_price and offer.get("price") and offer["price"] > max_price:
        return False
    return True


def find_matches(offer):
    rows = db_all("SELECT * FROM interests WHERE enabled=1")
    return [r["name"] for r in rows if interest_matches(r, offer)]


# --------------------------------------------------------------------------- #
# Ingestao
# --------------------------------------------------------------------------- #
# canais: {id: {"ultimoSinal": ms, "avisado": bool}} - cada canal fica aberto numa aba do Chrome
STATE = {"last_heartbeat": 0, "canais": {}, "last_ingest": 0}
_poll_cond = threading.Condition()


def offer_row_to_json(r):
    r = dict(r)
    r["links"] = json.loads(r.get("links") or "[]")
    r["images"] = json.loads(r.get("images") or "[]")
    r["coupons"] = json.loads(r.get("coupons") or "[]")
    r["matched"] = json.loads(r.get("matched") or "[]")
    r.pop("fav", None)
    r.pop("notified", None)
    return r


def ingest(msg):
    mid = str(msg.get("id") or "").strip()
    if not mid:
        return None
    text = (msg.get("text") or "").strip()
    if not text and not msg.get("images"):
        return None
    parsed = parse_offer(msg)
    now = int(time.time() * 1000)
    posted = msg.get("timestamp")
    try:
        posted = int(posted) if posted else now
    except (TypeError, ValueError):
        posted = now
    existing = db_one("SELECT * FROM offers WHERE id=?", (mid,))
    offer = {"id": mid, "text": text, **parsed}
    matched = find_matches(offer)
    if existing:
        # Discord carrega embeds/imagens depois; atualiza sem renotificar
        if existing["text"] == text and json.loads(existing["images"] or "[]") == parsed["images"]:
            return None
        save_parsed(mid, text, parsed, matched)
        is_new = False
    else:
        db_exec(
            "INSERT INTO offers(id, channel, author, posted_at, received_at) VALUES(?,?,?,?,?)",
            (mid, msg.get("channel"), msg.get("author"), posted, now),
        )
        save_parsed(mid, text, parsed, matched)
        is_new = True
    STATE["last_ingest"] = now
    row = db_one("SELECT * FROM offers WHERE id=?", (mid,))
    if row["link"] and not row["enriquecido"]:
        enfileirar_foto(mid, row["link"], prioridade=0)
    # Notifica so mensagens recentes (nao o historico carregado ao abrir o canal)
    fresh = (now - posted) < 10 * 60 * 1000
    should = matched or get_setting("notify_all") == "1"
    if fresh and should and not row["notified"]:
        # Sem imagem/link ainda: espera 1 s (a prévia do Discord costuma chegar logo depois);
        # _notify_later ainda espera até ~2 s pela foto da página da loja
        delay = 0 if (parsed["image"] and parsed["link"]) else 1.0
        threading.Timer(delay, _notify_later, args=(mid,)).start()
    avisar_mudanca()
    print(f"[{'novo' if is_new else 'upd '}] {parsed['title'][:70]} | {fmt_brl(parsed['price'])} "
          f"| cupom={parsed['coupon']} | alertas={matched}")
    return row


def save_parsed(mid, text, parsed, matched, overwrite_store=False):
    # A foto da página da loja (não expira) fica na frente das fotos do Discord
    og = (db_one("SELECT og_image FROM offers WHERE id=?", (mid,)) or {}).get("og_image")
    if og:
        parsed = {**parsed, "image": og, "images": [og] + [i for i in parsed["images"] if i != og]}
    store_sql = "store=?" if overwrite_store else "store=COALESCE(?, store)"
    db_exec(
        f"""UPDATE offers SET text=?, title=?, price=?, old_price=?, coupon=?, coupons=?, coupon_note=?, link=?,
           coupon_link=?, {store_sql}, image=?, links=?, images=?, matched=? WHERE id=?""",
        (text, parsed["title"], parsed["price"], parsed["old_price"], parsed["coupon"], json.dumps(parsed["coupons"]),
         parsed["coupon_note"], parsed["link"], parsed["coupon_link"], parsed["store"],
         parsed["image"], json.dumps(parsed["links"]), json.dumps(parsed["images"]),
         json.dumps(matched), mid),
    )
    registrar_preco(mid)


# --------------------------------------------------------------------------- #
# Histórico de preços por item
# Cada oferta com preço vira um registro em historico_precos, ligado a um "item":
# o modelo (ex.: "RTX 5060 Ti 8GB", "PS5 Slim Digital") ou, se o modelo não for
# reconhecido, o código do produto na loja (KaBuM, Shopee, Mercado Livre...).
# --------------------------------------------------------------------------- #
_db.executescript("""
    CREATE TABLE IF NOT EXISTS historico_precos (
        offer_id TEXT PRIMARY KEY,
        item_key TEXT,
        item_nome TEXT,
        preco REAL,
        loja TEXT,
        data INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hist_item ON historico_precos(item_key, data);
""")
try:
    _db.execute("ALTER TABLE historico_precos ADD COLUMN produto TEXT")  # link do produto (identifica repost)
except sqlite3.OperationalError:
    pass

VRAM_OK = {2, 3, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32}
SUFIXO_GPU = {"ti": "Ti", "super": "Super", "ti super": "Ti Super", "xt": "XT", "xtx": "XTX", "gre": "GRE"}
NAO_E_PECA_AVULSA = r"\b(notebook|laptop|pc gamer|computador|desktop|kit upgrade)\b"
ACESSORIO = r"\b(controle|dualsense|capa|case|suporte|base|cabo|headset|fone|skin|pelicula|camera|volante|carregador|dock|bolsa)\b"


def _bundle(s):
    return bool(re.search(r"\+|\bbundle\b|\bjogos?\b|\bcom (o )?jogo|mario|pokemon|zelda", s))


def identificar_item(titulo, url=""):
    """Devolve (chave, nome) do item, ou (None, None) se não der para saber qual é."""
    s = " " + re.sub(r"[^a-z0-9+.\s-]", " ", normalize(titulo or "")) + " "
    s = re.sub(r"\s+", " ", s)

    # Placa de vídeo: RTX 5060 Ti 8GB, RX 9070 XT 16GB, Arc B580 12GB
    m = re.search(r"\b(rtx|gtx|rx|arc)\s*-?\s*([a-z]?\d{3,4})\s*(ti\s*super|ti|super|xtx|xt|gre)?\b", s)
    if m and not re.search(NAO_E_PECA_AVULSA, s):
        marca, modelo, suf = m.group(1), m.group(2), re.sub(r"\s+", " ", m.group(3) or "")
        vram = None
        for v in re.findall(r"\b(\d{1,2})\s*gb\b", s) + re.findall(r"\bo?(\d{1,2})g\b", s):
            if int(v) in VRAM_OK:
                vram = int(v)
                break
        nome = f"{marca.upper()} {modelo.upper()}" + (f" {SUFIXO_GPU[suf]}" if suf else "") + (f" {vram}GB" if vram else "")
        return "gpu:" + nome.lower(), nome

    console = " console " in s or s.strip().startswith(("ps5", "playstation", "nintendo switch", "xbox series"))
    if console and not re.search(ACESSORIO, s.replace("controle sem fio dualsense", "")):
        extra = " + jogo" if _bundle(s) else ""
        if re.search(r"\b(ps5|playstation\s*5)\b", s):
            versao = "Pro" if re.search(r"\bpro\b", s) else ("Slim" if "slim" in s else "")
            midia = "Digital" if "digital" in s else ("Disco" if re.search(r"\b(disk|disco|midia fisica|leitor|standard)\b", s) else "")
            nome = " ".join(p for p in ("PS5", versao, midia) if p) + extra
            return "console:" + nome.lower(), nome
        if "switch" in s:
            if re.search(r"switch\s*2\b", s):
                nome = "Nintendo Switch 2"
            elif "oled" in s:
                nome = "Nintendo Switch OLED"
            elif "lite" in s:
                nome = "Nintendo Switch Lite"
            else:
                nome = "Nintendo Switch"
            nome += extra
            return "console:" + nome.lower(), nome
        m = re.search(r"xbox\s*series\s*(s|x)\b", s)
        if m:
            cap = re.search(r"\b(512\s*gb|1\s*tb|2\s*tb)\b", s)
            nome = f"Xbox Series {m.group(1).upper()}" + (f" {cap.group(1).replace(' ', '').upper()}" if cap else "") + extra
            return "console:" + nome.lower(), nome

    if re.search(r"\bdualsense\b", s) and not console:
        nome = "Controle DualSense Edge" if "edge" in s else "Controle DualSense"
        return "controle:" + nome.lower(), nome
    if re.search(r"\bcontrole\b.*\bxbox\b|\bxbox\b.*\bcontrole\b", s) and not console:
        return "controle:controle xbox", "Controle Xbox"

    # Não reconheceu o modelo: usa o código do produto na loja
    u = url or ""
    for padrao, loja in ((r"kabum\.com\.br/produto/(\d+)", "kabum"), (r"shopee\.com\.br/.*?i\.(\d+\.\d+)", "shopee"),
                         (r"shopee\.com\.br/(?:product|opaanlp)/(\d+/\d+)", "shopee"), (r"(MLB-?\d{6,})", "ml"),
                         (r"amazon\.com\.br/.*?/(?:dp|gp/product)/([A-Z0-9]{10})", "amazon"),
                         (r"magazineluiza\.com\.br/.*?/p/([a-z0-9]{6,})/", "magalu"),
                         (r"pichau\.com\.br/([a-z0-9-]{15,})", "pichau")):
        m = re.search(padrao, u, re.I)
        if m:
            return f"{loja}:{m.group(1).replace('/', '.').replace('-', '').lower()}", clean_line(titulo or "")[:60]
    return None, None


def registrar_preco(mid):
    o = db_one("SELECT id, title, price, store, posted_at, link, final_url FROM offers WHERE id=?", (mid,))
    chave, nome = (None, None)
    if o and o["price"] and o["price"] >= 20:
        chave, nome = identificar_item(o["title"], o["final_url"] or o["link"] or "")
    if not chave:
        db_exec("DELETE FROM historico_precos WHERE offer_id=?", (mid,))
        return
    produto = (o["final_url"] or o["link"] or o["title"] or "").split("?")[0].lower()
    db_exec("INSERT OR REPLACE INTO historico_precos(offer_id, item_key, item_nome, preco, loja, data, produto) VALUES(?,?,?,?,?,?,?)",
            (mid, chave, nome, o["price"], o["store"], o["posted_at"], produto))


def estatisticas(chave):
    """Menor preço (e quando), média e quantidade, sem contar repost (mesmo produto e preço no mesmo dia)."""
    rows = db_all("SELECT item_nome, preco, loja, data, produto FROM historico_precos WHERE item_key=? ORDER BY data", (chave,))
    vistos, lista = set(), []
    for r in rows:
        k = (r["preco"], r["produto"] or (r["loja"] or "").lower(), time.strftime("%Y-%m-%d", time.localtime(r["data"] / 1000)))
        if k not in vistos:
            vistos.add(k)
            lista.append(r)
    if not lista:
        return None
    menor = min(lista, key=lambda r: (r["preco"], r["data"]))
    return {
        "nome": lista[-1]["item_nome"],
        "menor": menor["preco"],
        "menorEm": menor["data"],
        "menorLoja": menor["loja"],
        "media": round(sum(r["preco"] for r in lista) / len(lista), 2),
        "maior": max(r["preco"] for r in lista),
        "n": len(lista),
        "ultimos": [{"preco": r["preco"], "loja": r["loja"], "data": r["data"]} for r in lista[-8:]][::-1],
    }


def anexar_historico(ofertas):
    """Coloca em cada oferta o resumo do histórico do item dela (uma consulta por item)."""
    ids = [o["id"] for o in ofertas]
    chaves = {}
    for i in range(0, len(ids), 500):
        parte = ids[i:i + 500]
        for r in db_all(f"SELECT offer_id, item_key FROM historico_precos WHERE offer_id IN ({','.join('?' * len(parte))})", parte):
            chaves[r["offer_id"]] = r["item_key"]
    cache = {}
    for o in ofertas:
        k = chaves.get(o["id"])
        if k and k not in cache:
            cache[k] = estatisticas(k)
        o["historico"] = cache.get(k) if k else None
    return ofertas


# Fila única que abre os links das ofertas (uma página por vez): descobre a loja dos encurtadores
# e pega a foto do produto. Ofertas novas (prioridade 0) passam na frente das antigas (1).
_fila_fotos = queue.PriorityQueue()
_diag_vistos = set()
_contador_fila = iter(range(10**12))


def enfileirar_foto(mid, link, prioridade=1):
    _fila_fotos.put((prioridade, next(_contador_fila), mid, link))


def enriquecer(mid, link):
    final, foto = buscar_pagina(link)
    if not foto and final and not any(s in final for s in SEM_FOTO_NO_HTML):
        time.sleep(2)  # falha momentânea da loja (acontece na KaBuM): tenta mais uma vez
        _, foto = buscar_pagina(final)  # direto na página final (sem passar pelo encurtador de novo)
    store = detect_store([final]) if final else None
    row = db_one("SELECT images, store FROM offers WHERE id=?", (mid,))
    if not row:
        return
    imagens = json.loads(row["images"] or "[]")
    if foto:
        imagens = [foto] + [i for i in imagens if i != foto]
    db_exec("""UPDATE offers SET final_url=?, og_image=?, enriquecido=1, store=COALESCE(store, ?),
               image=COALESCE(?, image), images=? WHERE id=?""",
            (final or "", foto, store, foto, json.dumps(imagens), mid))
    registrar_preco(mid)  # com o link final dá para reconhecer o produto pelo código da loja
    if foto or (store and not row["store"]):
        avisar_mudanca()
    print(f"[foto] {'ok ' if foto else '-- '} {(store or row['store'] or '?'):14} {(final or link)[:70]}")


def trabalhador_fotos():
    while True:
        _, _, mid, link = _fila_fotos.get()
        try:
            enriquecer(mid, link)
        except Exception as exc:  # noqa: BLE001 - uma pagina com problema nao para a fila
            print(f"[foto] erro em {link[:60]}: {exc}")
            db_exec("UPDATE offers SET enriquecido=1 WHERE id=?", (mid,))


def reparse_all():
    """Reaplica o parser atual em todas as ofertas salvas (ao iniciar)."""
    rows = db_all("SELECT id, text, links, images, store, link, final_url, enriquecido FROM offers ORDER BY posted_at DESC")
    for r in rows:
        msg = {"text": r["text"], "links": json.loads(r["links"] or "[]"),
               "images": json.loads(r["images"] or "[]")}
        parsed = parse_offer(msg)
        if r["final_url"] and not parsed["store"]:
            parsed["store"] = detect_store([r["final_url"]])
        save_parsed(r["id"], r["text"], parsed, find_matches({"id": r["id"], "text": r["text"], **parsed}),
                    overwrite_store=True)
        if parsed["link"] and not r["enriquecido"]:
            enfileirar_foto(r["id"], parsed["link"], prioridade=1)
    if rows:
        print(f"[parser] {len(rows)} ofertas reprocessadas")


def _notify_later(mid):
    # Sem foto ainda: espera até ~2 s a busca na página da loja, para a notificação já sair com foto
    for _ in range(8):
        row = db_one("SELECT image, enriquecido, link FROM offers WHERE id=?", (mid,))
        if not row or row["image"] or row["enriquecido"] or not row["link"]:
            break
        time.sleep(0.25)
    row = db_one("SELECT * FROM offers WHERE id=?", (mid,))
    if row and not row["notified"]:
        db_exec("UPDATE offers SET notified=1 WHERE id=?", (mid,))  # evita duplicar
        notify_offer(row, json.loads(row["matched"] or "[]"))


def avisar_mudanca():
    """Algo mudou nas ofertas: acorda o app do PC (long-poll) e agenda a publicacao no Gist."""
    STATE["last_ingest"] = int(time.time() * 1000)
    with _poll_cond:
        _poll_cond.notify_all()
    _publicar.set()


def fmt_brl(v):
    if v is None:
        return ""
    s = f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return "R$ " + (s[:-3] if s.endswith(",00") else s)


def rematch():
    """Recalcula quais ofertas recentes batem com os alertas (sem notificar)."""
    for r in db_all("SELECT id, title, text, price FROM offers ORDER BY posted_at DESC LIMIT 500"):
        db_exec("UPDATE offers SET matched=? WHERE id=?", (json.dumps(find_matches(r)), r["id"]))
    avisar_mudanca()


# --------------------------------------------------------------------------- #
# Alertas: mesmo formato no PC (/api/alertas) e no celular (alertas.json no Gist).
# Quem gravou por ultimo (ts maior) vale.
# --------------------------------------------------------------------------- #
def alertas_json():
    rows = db_all("SELECT name, query, max_price, enabled FROM interests ORDER BY id")
    return {
        "ts": int(get_setting("alertas_ts") or 0),
        "notificarTodas": get_setting("notify_all") == "1",
        "alertas": [{"nome": r["name"], "termos": r["query"], "precoMax": r["max_price"],
                     "ativo": bool(r["enabled"])} for r in rows],
    }


def gravar_alertas(dados, ts=None):
    """Substitui a lista de alertas. Devolve o JSON gravado."""
    lista = []
    for a in dados.get("alertas") or []:
        nome = str(a.get("nome") or "").strip()[:60]
        if not nome:
            continue
        termos = str(a.get("termos") or nome).strip()[:300]
        try:
            preco = float(a["precoMax"]) if a.get("precoMax") not in (None, "") else None
        except (TypeError, ValueError):
            preco = None
        lista.append((nome, termos, preco, 1 if a.get("ativo", True) else 0))
    with _db_lock:
        _db.execute("DELETE FROM interests")
        _db.executemany(
            "INSERT INTO interests(name, query, max_price, enabled, created_at) VALUES(?,?,?,?,?)",
            [(*x, int(time.time() * 1000)) for x in lista])
        _db.commit()
    set_setting("notify_all", "1" if dados.get("notificarTodas") else "0")
    set_setting("alertas_ts", str(ts or int(time.time() * 1000)))
    rematch()
    return alertas_json()


# --------------------------------------------------------------------------- #
# Celular: Gist secreto + Web Push (igual ao Rastreazera / FB Radar)
#   ofertas.json  publicado por aqui (o app do celular le daqui)
#   alertas.json  alertas; o celular e o PC gravam (o ts maior vale)
#   push.json     aparelhos inscritos (o celular grava; daqui sai o push)
# --------------------------------------------------------------------------- #
SITE_PUBLICO = "https://drakezera1337.github.io/ofertazera/"
PUSH_PEM = os.path.join(BASE_DIR, "push_vapid.pem")
PUSH_CONTATO = "mailto:276884055+Drakezera1337@users.noreply.github.com"
GIST_API = "https://api.github.com/gists"
GIST_DESCRICAO = "Ofertazera – ofertas do Discord"
PUBLICAR_MAX = 150                # ofertas no ofertas.json
GIST_LER_S = 20                   # confere push.json / alertas.json
GIST_REPUBLICAR_S = 5 * 60        # sem novidade, republica (o celular ve que o PC esta vivo)

_publicar = threading.Event()
_push = {"inscricoes": [], "testes": {}, "lock": threading.Lock()}
_webpush = None


def gist_cfg():
    token, gid = get_setting("gist_token"), get_setting("gist_id")
    return {"token": token, "gistId": gid} if token and gid else None


def github(url, token, method="GET", corpo=None):
    req = urllib.request.Request(
        url, method=method, data=json.dumps(corpo).encode() if corpo is not None else None,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "Ofertazera"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def gist_request(method="GET", corpo=None):
    cfg = gist_cfg()
    return github(f"{GIST_API}/{cfg['gistId']}", cfg["token"], method, corpo)


def conectar_gist(token):
    """Usa o Gist do Ofertazera que ja existe na conta; senao cria um (secreto)."""
    lista = github(f"{GIST_API}?per_page=100", token)
    existente = next((g for g in lista if g.get("description") == GIST_DESCRICAO), None)
    if existente:
        gid, criado = existente["id"], False
    else:
        gid = github(GIST_API, token, "POST", {
            "description": GIST_DESCRICAO, "public": False,
            "files": {"ofertas.json": {"content": "{}"}, "push.json": {"content": "[]"}}})["id"]
        criado = True
    set_setting("gist_token", token)
    set_setting("gist_id", gid)
    _publicar.set()
    return gid, criado


def json_do_arquivo(arquivos, nome, padrao):
    arq = arquivos.get(nome)
    if not arq:
        return padrao
    conteudo = arq.get("content") or ""
    if arq.get("truncated") and arq.get("raw_url"):
        with urllib.request.urlopen(arq["raw_url"], timeout=30) as r:
            conteudo = r.read().decode("utf-8")
    try:
        return json.loads(conteudo) if conteudo else padrao
    except ValueError:
        return padrao


def oferta_publica(r):
    o = offer_row_to_json(r)
    o["text"] = (o.get("text") or "")[:1500]
    for k in ("final_url", "received_at"):
        o.pop(k, None)
    return o


def nomes_canais():
    """{id: nome} dos canais (o nome vem do titulo da aba e fica guardado)."""
    return json.loads(get_setting("canais") or "{}")


def status_monitor():
    agora = time.time() * 1000
    nomes = nomes_canais()
    canais = [{"id": cid, "nome": nomes.get(cid) or cid, "ultimoSinal": c["ultimoSinal"],
               "ativo": agora - c["ultimoSinal"] < 90_000} for cid, c in STATE["canais"].items()]
    last = STATE["last_heartbeat"]
    return {
        "monitorando": any(c["ativo"] for c in canais),
        "ultimoSinal": last,
        "canal": ", ".join(c["nome"] for c in canais if c["ativo"]),
        "canais": canais,
        "nomesCanais": nomes,
    }


def publicar_gist(incluir_alertas=False):
    rows = db_all("SELECT * FROM offers ORDER BY posted_at DESC LIMIT ?", (PUBLICAR_MAX,))
    arquivos = {"ofertas.json": {"content": json.dumps({
        "ofertas": anexar_historico([oferta_publica(r) for r in rows]),
        "status": status_monitor(),
        "ts": int(time.time() * 1000),
    }, ensure_ascii=False)}}
    if incluir_alertas:
        arquivos["alertas.json"] = {"content": json.dumps(alertas_json(), ensure_ascii=False)}
    gist_request("PATCH", {"files": arquivos})


def carregar_webpush():
    global _webpush
    if _webpush is None:
        vendor = os.path.join(BASE_DIR, ".vendor")
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        try:
            from pywebpush import WebPushException, webpush
            _webpush = (webpush, WebPushException)
        except ImportError as exc:
            print(f"[push] desligado: pywebpush nao encontrado em .vendor ({exc})")
            _webpush = False
    return _webpush or None


def enviar_push(payload, inscricoes=None):
    """Envia para os aparelhos inscritos; tira do push.json os que nao existem mais."""
    lib = carregar_webpush()
    if inscricoes is None:
        with _push["lock"]:
            inscricoes = list(_push["inscricoes"])
    if not lib or not inscricoes or not os.path.exists(PUSH_PEM):
        return 0
    webpush, WebPushException = lib
    mortos, ok = [], 0
    for insc in inscricoes:
        try:
            webpush(subscription_info={"endpoint": insc["endpoint"], "keys": insc["keys"]},
                    data=json.dumps(payload, ensure_ascii=False), vapid_private_key=PUSH_PEM,
                    vapid_claims={"sub": PUSH_CONTATO}, ttl=3600, timeout=15,
                    headers={"Urgency": "high"})
            ok += 1
        except WebPushException as exc:
            if getattr(exc.response, "status_code", None) in (404, 410):
                mortos.append(insc["endpoint"])
            print(f"[push] {insc.get('aparelho', '?')}: {exc}")
        except (KeyError, TypeError) as exc:
            print(f"[push] inscricao invalida: {exc}")
    if mortos and gist_cfg():
        with _push["lock"]:
            _push["inscricoes"] = [i for i in _push["inscricoes"] if i["endpoint"] not in mortos]
            vivos = list(_push["inscricoes"])
        try:
            gist_request("PATCH", {"files": {"push.json": {"content": json.dumps(vivos, indent=1)}}})
        except Exception as exc:  # noqa: BLE001
            print(f"[push] nao consegui limpar push.json: {exc}")
    return ok


MESES = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")


def mes_ano(ms):
    t = time.localtime(ms / 1000)
    return f"{MESES[t.tm_mon - 1]}/{t.tm_year}"


def payload_oferta(o, matched):
    linhas = []
    if o.get("price"):
        p = fmt_brl(o["price"])
        if o.get("old_price"):
            p += f" (de {fmt_brl(o['old_price'])})"
        linhas.append("💰 " + p + (f" · {o['store']}" if o.get("store") else ""))
    elif o.get("store"):
        linhas.append("🛒 " + o["store"])
    cupons = json.loads(o["coupons"]) if isinstance(o.get("coupons"), str) else (o.get("coupons") or [])
    if cupons or o.get("coupon"):
        linhas.append(("🏷️ Cupons: " if len(cupons) > 1 else "🏷️ Cupom: ") + (" · ".join(cupons) or o["coupon"]))
    elif o.get("coupon_note"):
        linhas.append("🎟️ " + o["coupon_note"] + " — resgate antes")
    hist = anexar_historico([{"id": o["id"]}])[0]["historico"] if o.get("price") else None
    if hist and hist["n"] > 1:
        if o["price"] <= hist["menor"]:
            linhas.append(f"🔥 Menor preço já visto (média {fmt_brl(hist['media'])})")
        else:
            linhas.append(f"📊 Menor {fmt_brl(hist['menor'])} ({mes_ano(hist['menorEm'])}) · média {fmt_brl(hist['media'])}")
    titulo = o["title"]
    if matched:
        titulo = f"🎯 {matched[0]} · {titulo}"
    # Resumo da oferta vai junto: o app abre o detalhe na hora, mesmo antes do Gist atualizar
    resumo = {k: o.get(k) for k in ("id", "title", "price", "old_price", "coupon", "coupon_note",
                                    "link", "coupon_link", "store", "image", "posted_at", "channel")}
    resumo["coupons"] = cupons
    if hist:  # sem a lista "ultimos": o push tem limite de tamanho
        resumo["historico"] = {k: v for k, v in hist.items() if k != "ultimos"}
    return {
        "title": titulo[:120],
        "body": "\n".join(linhas) or (o.get("text") or "")[:160],
        "tag": "oferta-" + o["id"],
        "image": o.get("image"),
        "oferta": resumo,
    }


def notify_offer(row, matched):
    n = enviar_push(payload_oferta(row, matched))
    print(f"[push] {row['title'][:50]} -> {n} aparelho(s)")


def processar_gist():
    """Le push.json (inscricoes + pedidos de teste) e alertas.json (alteracoes vindas do celular)."""
    arquivos = gist_request().get("files") or {}
    inscricoes = [i for i in json_do_arquivo(arquivos, "push.json", [])
                  if isinstance(i, dict) and i.get("endpoint") and i.get("keys")]
    with _push["lock"]:
        _push["inscricoes"] = inscricoes
    testes = json.loads(get_setting("push_testes") or "{}")
    for insc in inscricoes:
        if insc.get("testeEm", 0) > testes.get(insc["endpoint"], 0):
            testes[insc["endpoint"]] = insc["testeEm"]
            enviar_push({"title": "Ofertazera", "body": "🔔 Teste: as notificações estão funcionando neste aparelho!",
                         "tag": "ofertazera-teste"}, [insc])
            print(f"[push] teste enviado ({insc.get('aparelho', '?')})")
    set_setting("push_testes", json.dumps(testes))

    # Devolve True quando o alertas.json do Gist esta mais velho que o daqui (precisa publicar)
    remoto = json_do_arquivo(arquivos, "alertas.json", None)
    remoto_ts = int(remoto.get("ts") or 0) if isinstance(remoto, dict) else -1
    local_ts = int(get_setting("alertas_ts") or 0)
    if remoto_ts > local_ts:
        gravar_alertas(remoto, ts=remoto_ts)
        print(f"[alertas] atualizados pelo celular ({len(remoto.get('alertas') or [])})")
        return False
    return local_ts > remoto_ts


def laco_gist():
    ultima_leitura = ultima_publicacao = 0
    publicar_alertas = True
    while True:
        acordou = _publicar.wait(timeout=5)
        if acordou:
            time.sleep(1.0)  # junta varias mensagens chegando juntas num PATCH so
            _publicar.clear()
        if not gist_cfg():
            continue
        agora = time.time()
        try:
            if agora - ultima_leitura > GIST_LER_S:
                ultima_leitura = agora
                publicar_alertas = processar_gist() or publicar_alertas
            if STATE.pop("alertas_sujos", False):
                publicar_alertas = True
            if acordou or publicar_alertas or agora - ultima_publicacao > GIST_REPUBLICAR_S:
                publicar_gist(incluir_alertas=publicar_alertas)
                ultima_publicacao, publicar_alertas = agora, False
        except Exception as exc:  # noqa: BLE001 - sem internet, token trocado...: tenta de novo
            print(f"[gist] {exc}")
            time.sleep(10)


def watchdog():
    while True:
        time.sleep(30)
        nomes = nomes_canais()
        for cid, c in list(STATE["canais"].items()):
            idle_min = (time.time() * 1000 - c["ultimoSinal"]) / 60000
            if idle_min > HEARTBEAT_ALERT_MIN and not c["avisado"]:
                c["avisado"] = True
                _publicar.set()
                enviar_push({"title": f"⚠️ Parou de monitorar: {nomes.get(cid) or 'canal'}",
                             "body": "A aba desse canal fechou ou o PC dormiu. Abra o canal no Chrome do PC.",
                             "tag": "ofertazera-monitor-" + cid})


# --------------------------------------------------------------------------- #
# HTTP (so no proprio PC: a extensao e o app em localhost)
# --------------------------------------------------------------------------- #
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE_DIR, **kw)

    def log_message(self, fmt, *args):  # silencioso
        pass

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    # Arquivos do servidor que nunca podem ser servidos
    PRIVADOS = (".db", ".pem", ".tmp", ".py", ".bat", ".md")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        path = u.path
        if path == "/api/offers":
            limit = min(int(qs.get("limit") or 200), 500)
            rows = db_all("SELECT * FROM offers ORDER BY posted_at DESC LIMIT ?", (limit,))
            return self._json(anexar_historico([offer_row_to_json(r) for r in rows]))
        if path == "/api/alertas":
            return self._json(alertas_json())
        if path == "/api/status":
            return self._json(self.status_json())
        if path == "/api/celular":
            # link de configuracao do celular (vai no QR code); so existe com o Gist conectado
            cfg = gist_cfg()
            if not cfg:
                return self._json({"erro": "Conecte o Gist primeiro"}, 400)
            dados = json.dumps(cfg, separators=(",", ":")).encode()
            b64 = urllib.parse.quote(__import__("base64").urlsafe_b64encode(dados).decode().rstrip("="))
            return self._json({"url": f"{SITE_PUBLICO}#config={b64}"})
        if path == "/api/wait":
            # long-poll: segura ate chegar algo novo (max 25s)
            since = int(qs.get("since") or 0)
            deadline = time.time() + 25
            with _poll_cond:
                while STATE["last_ingest"] <= since and time.time() < deadline:
                    _poll_cond.wait(timeout=max(0.1, deadline - time.time()))
            return self._json({"last_ingest": STATE["last_ingest"]})
        if path.lower().endswith(self.PRIVADOS) or "/." in path:
            return self._json({"error": "não encontrado"}, 404)
        return super().do_GET()

    def status_json(self):
        cfg = gist_cfg()
        with _push["lock"]:
            aparelhos = [i.get("aparelho", "?") for i in _push["inscricoes"]]
        return {
            **status_monitor(),
            "last_ingest": STATE["last_ingest"],
            "total": db_one("SELECT COUNT(*) AS n FROM offers")["n"],
            "gist": {"id": cfg["gistId"], "tokenFim": cfg["token"][-4:]} if cfg else None,
            "aparelhos": aparelhos,
            "pushPronto": os.path.exists(PUSH_PEM) and bool(carregar_webpush()),
            "server_time": int(time.time() * 1000),
        }

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        if path == "/api/ingest":
            msgs = body.get("messages") or ([body] if body.get("id") else [])
            for m in msgs:
                # mensagem com anexo/prévia em que a extensão não achou imagem: registra a estrutura
                if m.get("diag") and m.get("id") not in _diag_vistos:
                    _diag_vistos.add(m.get("id"))
                    print(f"[diag-imagem] {m.get('id')} {str(m.get('text') or '')[:40]!r}: {str(m['diag'])[:1500]}")
            n = sum(1 for m in msgs if ingest(m))
            return self._json({"ok": True, "processed": n})
        if path == "/api/heartbeat":
            agora = int(time.time() * 1000)
            m = re.search(r"/channels/[^/]+/(\d+)", str(body.get("url") or ""))
            cid = str(body.get("channel") or (m.group(1) if m else "?"))
            STATE["last_heartbeat"] = agora
            c = STATE["canais"].setdefault(cid, {"ultimoSinal": agora, "avisado": False})
            c["ultimoSinal"] = agora
            nome = str(body.get("channelName") or "").strip()[:60]
            nomes = nomes_canais()
            if nome and nomes.get(cid) != nome:
                nomes[cid] = nome
                set_setting("canais", json.dumps(nomes, ensure_ascii=False))
                _publicar.set()
            if c["avisado"]:
                c["avisado"] = False
                _publicar.set()
                enviar_push({"title": f"✅ Voltou a monitorar: {nomes.get(cid) or 'canal'}", "body": "Tudo certo de novo.",
                             "tag": "ofertazera-monitor-" + cid})
            return self._json({"ok": True})
        if path == "/api/alertas":
            STATE["alertas_sujos"] = True
            return self._json(gravar_alertas(body))
        if path == "/api/gist":
            token = str(body.get("token") or "").strip()
            if not token:
                return self._json({"erro": "Cole o token do GitHub"}, 400)
            try:
                gid, criado = conectar_gist(token)
            except urllib.error.HTTPError as e:
                msg = {401: "token inválido", 403: "o token não tem a permissão gist"}.get(e.code, f"erro {e.code}")
                return self._json({"erro": msg}, 400)
            except Exception as e:  # noqa: BLE001
                return self._json({"erro": str(e)}, 400)
            return self._json({"ok": True, "gistId": gid, "criado": criado})
        if path == "/api/push-teste":
            n = enviar_push({"title": "Ofertazera", "body": "🔔 Teste: as notificações estão funcionando!",
                             "tag": "ofertazera-teste"})
            return self._json({"ok": n > 0, "aparelhos": n})
        return self._json({"error": "rota inválida"}, 404)


class Servidor(ThreadingHTTPServer):
    # No Windows, SO_REUSEADDR deixaria um segundo server.py escutar a mesma porta junto com o primeiro
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True


def log_sem_janela():
    """Com pythonw.exe (inicio automatico, sem janela) nao ha console: as mensagens vao para server.log."""
    if sys.stdout is not None:
        return
    caminho = os.path.join(BASE_DIR, "server.log")
    if os.path.exists(caminho) and os.path.getsize(caminho) > 2_000_000:
        os.replace(caminho, caminho + ".1")  # guarda so o anterior
    arquivo = open(caminho, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = arquivo
    print(f"\n--- iniciado em {time.strftime('%d/%m/%Y %H:%M:%S')} ---")


def main():
    log_sem_janela()
    try:
        server = Servidor(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"O Ofertazera já está rodando (porta {PORT} ocupada).")
        return
    threading.Thread(target=trabalhador_fotos, daemon=True).start()
    reparse_all()
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=laco_gist, daemon=True).start()
    cfg = gist_cfg()
    print("=" * 60)
    print(" OFERTAZERA rodando!")
    print(f"   No PC:      http://localhost:{PORT}/")
    print(f"   Celular:    {SITE_PUBLICO}  ({'Gist conectado' if cfg else 'conecte o Gist em Ajustes'})")
    print(f"   Push:       {'pronto' if os.path.exists(PUSH_PEM) and carregar_webpush() else 'FALTA push_vapid.pem ou .vendor'}")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
