/**
 * ChessMeta Game - Online Multiplayer Relay Backend
 * ---------------------------------------------------------
 * Express (HTTP, sağlık kontrolü + statik lobi) + ws (WebSocket)
 * üzerine kurulu, YALNIZCA hamleleri yansıtan (relay) bir sunucu.
 *
 * Mimari: "Relay"
 *  - Oyun kurallarının doğrulaması İKİ İSTEMCİDE DE (HTML5 board.js)
 *    çalışır; sunucu tahtayı tutmaz, sadece hamleyi karşı tarafa iletir.
 *  - Bu sayede sunucu basit, hızlı ve hataya kapalı kalır.
 *
 * Akış:
 *  1. İstemci bağlanır -> {type:'hello', name} gönderir.
 *  2. İstemci `create` (yeni oda) veya `join` (roomId ile) der.
 *  3. İki oyuncu bir odada eşleşince sunucu her ikisine de
 *     {type:'start', color, roomId, opponent} yollar.
 *  4. Oyuncular {type:'move', move} ile hamlelerini yollar; sunucu
 *     hamleyi odadaki DİĞER oyuncuya {type:'move', move, by} olarak iletir.
 *  5. {type:'resign'} / {type:'draw-request'} gibi kontrol mesajları da
 *     aynen karşı tarafa yansıtılır.
 *  6. Bağlantı koparsa oda düşmanına {type:'opponent-left'} gider.
 *
 * Oda kodu: 4 karakterli (A-Z 0-9), kolay paylaşılabilir.
 *
 * Hızlı Eşleşme (Quick Match / otomatik rakip bulma):
 *  - İstemci {type:'quick-match'} gönderir.
 *  - Kuyrukta bekleyen başka bir oyuncu varsa hemen eşleştirilir ve
 *    her ikisine de {type:'start', ...} yollanır (oda kodu olmadan).
 *  - Kuyrukta kimse yoksa istemci kuyruğa eklenir ve {type:'queued'}
 *    cevabı döner ("rakip aranıyor" ekranı bunu dinler).
 *  - İstemci {type:'cancel-quick-match'} ile kuyruktan çıkabilir.
 *  - Bağlantı koparsa kuyruktan otomatik olarak çıkarılır.
 * ---------------------------------------------------------
 */

const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

const app = express();

// Basit sağlık kontrolü (Render ve diğer PaaS'lar bunu kullanır).
app.get("/", (req, res) => {
  res.json({ ok: true, service: "chessmeta-server", rooms: rooms.size, queued: quickQueue.length });
});

app.get("/healthz", (req, res) => res.status(200).send("ok"));

// İsteğe bağlı: basit bir lobi/statik sayfa (roomId üreteci ile).
app.get("/lobby", (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8">
  <title>ChessMeta Lobby</title><style>body{font-family:system-ui;padding:40px;background:#111;color:#eee}
  code{background:#222;padding:4px 8px;border-radius:6px;font-size:20px}</style></head>
  <body><h1>ChessMeta Online</h1><p>Sunucu çalışıyor.</p>
  <p>Yeni oda kodu: <code>${generateRoomCode()}</code></p>
  <p>Toplam aktif oda: <b>${0}</b></p></body></html>`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Bağlantı nabzı (heartbeat) -------------------------------------------
// Sorun: Bir oyuncunun ağı sessizce koparsa (uçak modu, uygulama arka
// planda öldürülürse, wifi/mobil veri kesilirse) WebSocket'in 'close'
// olayı TCP katmanında çok geç (bazen hiç) tetiklenebilir; bu da diğer
// oyuncunun "rakip ayrıldı / kazandın" mesajını dakikalarca beklemesine
// yol açar. Çözüm: sunucu her HEARTBEAT_MS'de bir istemcilere 'ping'
// gönderir; bir önceki turda 'pong' ile cevap vermeyen bağlantı ölü kabul
// edilip terminate() edilir -> bu da anında leaveRoom() tetikler ve
// rakibe 'opponent-left' gider.
const HEARTBEAT_MS = 5000; // her 5 saniyede bir nabız kontrolü

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // İki tur üst üste cevap yok -> bağlantı sessizce kopmuş, hemen
      // sonlandır (bu 'close' olayını tetikler ve rakibe bildirim gider).
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* yoksay */ }
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeatInterval));
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {Map<string, import('ws').WebSocket>} players  peerId -> ws
 * @property {string[]} order  oyuncu sırası (ilk katılan = black)
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

// --- Hızlı Eşleşme (Quick Match) kuyruğu ----------------------------------
// Rakip bekleyen (henüz eşleşmemiş) bağlantıların listesi. Basit bir FIFO:
// kuyruğa giren ilk oyuncu, sıradaki ilk gelenle eşleşir.
/** @type {import('ws').WebSocket[]} */
const quickQueue = [];

function removeFromQueue(ws) {
  const idx = quickQueue.indexOf(ws);
  if (idx !== -1) quickQueue.splice(idx, 1);
  ws.inQueue = false;
}

function startRoomFor(wsA, wsB) {
  // İlk eşleşen siyah (ilk hamle), ikinci beyaz olur.
  const roomId = generateRoomCode();
  /** @type {Room} */
  const room = { id: roomId, players: new Map(), order: [wsA.peerId, wsB.peerId] };
  room.players.set(wsA.peerId, wsA);
  room.players.set(wsB.peerId, wsB);
  wsA.room = room;
  wsB.room = room;
  rooms.set(roomId, room);

  send(wsA, { type: "start", roomId, color: "black", opponent: wsB.name });
  send(wsB, { type: "start", roomId, color: "white", opponent: wsA.name });
}

function tryQuickMatch(ws) {
  if (ws.room) leaveRoom(ws);
  if (ws.inQueue) return; // zaten kuyrukta

  // Kuyrukta bekleyen (ve hâlâ bağlı olan) başka bir oyuncu var mı?
  while (quickQueue.length > 0) {
    const opponent = quickQueue.shift();
    opponent.inQueue = false;
    if (opponent === ws || opponent.readyState !== opponent.OPEN) continue;
    return startRoomFor(opponent, ws);
  }

  // Kuyruk boş -> bu oyuncuyu kuyruğa ekle, rakip aranıyor bilgisini gönder.
  ws.inQueue = true;
  quickQueue.push(ws);
  return send(ws, { type: "queued" });
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // karışabilen 0/O, 1/I çıkarıldı

function generateRoomCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj, exceptPeerId) {
  for (const [peerId, client] of room.players) {
    if (peerId !== exceptPeerId) send(client, obj);
  }
}

function otherPeerId(room, peerId) {
  for (const id of room.players.keys()) if (id !== peerId) return id;
  return null;
}

function leaveRoom(ws) {
  removeFromQueue(ws);
  const room = ws.room;
  if (!room) return;
  // Kalan oyuncuya ayrıldığını bildir.
  const other = otherPeerId(room, ws.peerId);
  if (other) send(room.players.get(other), { type: "opponent-left" });
  room.players.delete(ws.peerId);
  if (room.players.size === 0) {
    rooms.delete(room.id);
  }
  ws.room = null;
}

wss.on("connection", (ws) => {
  ws.peerId = Math.random().toString(36).slice(2, 10);
  ws.room = null;
  ws.inQueue = false;
  ws.name = "Player";

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "Geçersiz JSON" });
    }

    switch (msg.type) {
      case "hello": {
        if (typeof msg.name === "string" && msg.name.trim()) {
          ws.name = msg.name.trim().slice(0, 20);
        }
        return send(ws, { type: "welcome", peerId: ws.peerId });
      }

      case "create": {
        removeFromQueue(ws);
        if (ws.room) leaveRoom(ws);
        const roomId = generateRoomCode();
        /** @type {Room} */
        const room = { id: roomId, players: new Map(), order: [] };
        room.players.set(ws.peerId, ws);
        room.order.push(ws.peerId);
        ws.room = room;
        rooms.set(roomId, room);
        // Oda kurucu siyah (ilk hamle) olur.
        return send(ws, {
          type: "created",
          roomId,
          color: "black",
          you: ws.name,
        });
      }

      case "quick-match": {
        tryQuickMatch(ws);
        return;
      }

      case "cancel-quick-match": {
        removeFromQueue(ws);
        return;
      }

      case "join": {
        removeFromQueue(ws);
        const roomId = (msg.roomId || "").toString().toUpperCase().trim();
        const room = rooms.get(roomId);
        if (!room) return send(ws, { type: "error", message: "Oda bulunamadı" });
        if (room.players.size >= 2) return send(ws, { type: "error", message: "Oda dolu" });

        room.players.set(ws.peerId, ws);
        room.order.push(ws.peerId);
        ws.room = room;

        // İki oyuncu hazır -> başlat.
        const [blackId, whiteId] = room.order;
        const blackName = room.players.get(blackId).name;
        const whiteName = room.players.get(whiteId).name;

        send(room.players.get(blackId), {
          type: "start",
          roomId,
          color: "black",
          opponent: whiteName,
        });
        send(room.players.get(whiteId), {
          type: "start",
          roomId,
          color: "white",
          opponent: blackName,
        });
        return;
      }

      case "move": {
        const room = ws.room;
        if (!room) return;
        // Hamleyi karşı tarafa aynen ilet (kurallar istemcide doğrulanır).
        const other = otherPeerId(room, ws.peerId);
        if (other) {
          send(room.players.get(other), { type: "move", move: msg.move, by: ws.peerId });
        }
        return;
      }

      case "resign":
      case "draw-request":
      case "draw-accept":
      case "draw-decline":
      case "rematch-request":
      case "chat": {
        const room = ws.room;
        if (!room) return;
        const other = otherPeerId(room, ws.peerId);
        if (other) {
          const out = { type: msg.type, by: ws.peerId };
          if (msg.type === "chat") out.text = String(msg.text || "").slice(0, 200);
          send(room.players.get(other), out);
        }
        return;
      }

      case "leave": {
        leaveRoom(ws);
        return;
      }

      default:
        return send(ws, { type: "error", message: `Bilinmeyen mesaj: ${msg.type}` });
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`[chessmeta-server] listening on :${PORT}`);
});
