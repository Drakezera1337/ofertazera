"""Sobe a versão do Ofertazera antes de publicar (python versao.py).

Atualiza, num número só:
- sw.js      → nome do cache do modo offline (ofertazera-vN)
- index.html → ?v=N nos arquivos CSS/JS (o celular baixa os novos, sem reaproveitar velhos)
- config.js  → OZ_VERSAO (aparece em Ajustes para conferir se o aparelho está atualizado)
"""
import re
from pathlib import Path

RAIZ = Path(__file__).parent


def ler(nome):
    return (RAIZ / nome).read_text(encoding="utf-8-sig")


def gravar(nome, texto):
    (RAIZ / nome).write_text(texto, encoding="utf-8")


atual = int(re.search(r"const OZ_VERSAO = (\d+);", ler("config.js")).group(1))
nova = atual + 1

gravar("sw.js", re.sub(r"ofertazera-v\d+", f"ofertazera-v{nova}", ler("sw.js")))
gravar("index.html", re.sub(r'((?:href|src)="[\w/.-]+\.(?:css|js))(?:\?v=\d+)?"', rf'\1?v={nova}"', ler("index.html")))
gravar("config.js", re.sub(r"const OZ_VERSAO = \d+;", f"const OZ_VERSAO = {nova};", ler("config.js")))
print(f"versao {atual} -> {nova}")
