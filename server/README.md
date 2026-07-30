# ChessMeta Game - Online Multiplayer Sunucusu
# ---------------------------------------------------------
# Express (HTTP) + ws (WebSocket) ile hamle-yansıtma (relay) backend'i.
# Detaylar: README bölümü ve server/index.js içindeki yorumlar.
#
# GitHub'a yükleme ve Render'a deploy adımlarının ayrıntılı anlatımı için
# repo kökündeki ana README.md dosyasındaki "🐙 GitHub üzerinde yönetim"
# ve "☁️ Render Deploy (backend)" bölümlerine bakın.

## Çalıştırma (yerel)

```bash
cd server
npm install
npm start
# http://localhost:3000  (sağlık: / , lobi: /lobby)
```

Ortam değişkenleri:
- `PORT` (varsayılan 3000) — dinlenecek port.

## Deploy (Render)

Render'da "Web Service" olarak kurulur. `render.yaml` otomatik yapılandırır;
ya da manuel:
- Environment: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Sağlık yolu: `/healthz`

İstemci (HTML5) tarafı sunucu adresini `js/online.js` içindeki
`ONLINE_SERVER_URL` sabitinden ayarlar. Varsayılan olarak aynı
origin'i (WebSocket upgrade) kullanır; Render'da `wss://<app>.onrender.com`.

## Protokol (WebSocket JSON mesajları)

İstemci -> Sunucu:
- `{type:'hello', name}`
- `{type:'create'}`
- `{type:'join', roomId}`
- `{type:'move', move}`  (move: board.js uyumlu hamle nesnesi)
- `{type:'resign'}`
- `{type:'draw-request' | 'draw-accept' | 'draw-decline'}`
- `{type:'rematch-request'}`
- `{type:'chat', text}`
- `{type:'leave'}`

Sunucu -> İstemci:
- `{type:'welcome', peerId}`
- `{type:'created', roomId, color:'black', you}`
- `{type:'start', roomId, color, opponent}`
- `{type:'move', move, by}`
- `{type:'opponent-left'}`
- `{type:'error', message}`
- kontrol mesajları (resign/draw/rematch/chat) aynen karşı tarafa yansıtılır.
