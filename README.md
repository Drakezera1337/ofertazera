# Ofertazera ⚡

Ofertas relâmpago do canal de consoles do Discord direto no celular, no estilo dos classificados,
com **notificação na hora** quando entra algo dos seus alertas. Tem cupom com botão de copiar,
link direto para a loja e o link de "resgatar cupons" separado do produto.

**Site:** https://drakezera1337.github.io/ofertazera/ (as ofertas aparecem depois de conectar o celular ao PC)

Mesmo esquema do Rastreazera / FB Radar:

```
Discord (aba aberta no Chrome do PC)
  └─ extensão Ofertazera (pasta extension/) lê as mensagens novas da tela
       └─ server.py (PC): extrai preço, cupom, loja e link; confere os alertas
            ├─ envia Web Push para os aparelhos inscritos (na hora)
            └─ publica ofertas.json num Gist secreto ──> app no celular (GitHub Pages)
```

A extensão não usa o token da conta nem a API do Discord: só lê o que já está na tela.

## Ligar no PC

1. `iniciar.bat` (ou `python server.py`) e abra http://localhost:8787
2. Chrome → `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem compactação** → pasta `extension`
3. Abra o canal no Discord **pelo Chrome** e dê F5. O selo do topo fica **ao vivo**.
4. Ajustes → **Celular** → cole um token do GitHub com permissão **gist** → **Conectar**

Para não perder ofertas: deixe o Discord numa janela própria do Chrome; em `chrome://settings/performance`
adicione `discord.com` em "Sempre manter estes sites ativos"; e não deixe o PC suspender.
Se a aba fechar, o celular recebe "⚠️ Ofertazera parou de monitorar".

## Ligar no celular

1. No PC: Ajustes → **Mostrar QR code**
2. No celular, abra o site → Ajustes → **📷 Ler QR do PC**
3. Instale: Chrome ⋮ → **Instalar app** (iPhone: Compartilhar → Adicionar à Tela de Início, e abra pelo ícone)
4. Ajustes → **🔔 Ativar notificações** → **Enviar teste**

Tocar na notificação abre a loja direto; se tiver cupom, abre o detalhe com **Copiar cupom e ir à loja**.

## Alertas

| Você escreve | Significa |
|---|---|
| `ps5, playstation 5` | qualquer um dos dois (vírgula = OU) |
| `controle xbox` | precisa ter as duas palavras |
| `ps5 -controle -jogo` | PS5, mas ignora controle e jogos |

Preço máximo opcional. Só ofertas que batem com algum alerta notificam, a não ser que você ligue
**Notificar TODAS as ofertas**. Alertas criados no celular chegam ao PC em até 30 s (pelo Gist).

## Publicar uma mudança

```bash
python versao.py
git add -A
git commit -m "..."
git push
```

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html`, `styles.css`, `app.js` | App (no PC lê o `server.py`; no celular, o Gist) |
| `sync.js` | Leitura/gravação no Gist (celular) |
| `config.js` | Endereço público e chave **pública** VAPID |
| `sw.js`, `manifest.webmanifest` | App instalável + notificações |
| `server.py` | Servidor local: parser, alertas, Gist e Web Push |
| `extension/` | Extensão do Chrome que lê o canal do Discord |
| `versao.py` | Sobe a versão antes de publicar |

Fora do git (só no PC): `push_vapid.pem` (chave privada), `.vendor/` (`pip install --target .vendor pywebpush`), `ofertazera.db`.
