import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 4;
const MAX_MSG = 2048;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeCode() {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Granny MP relay OK");
    }
    // /create  veya  /join/KOD   (?name=Oyuncu)
    const m = url.pathname.match(/^\/(create|join)(?:\/([A-Za-z0-9]{4,6}))?$/);
    if (!m) return new Response("bad path", { status: 400 });
    const mode = m[1];
    let code = (m[2] || "").toUpperCase();
    if (mode === "create") code = makeCode();
    if (mode === "join" && !code) return new Response("code required", { status: 400 });

    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const req = new Request(request);
    req.headers.set("X-Mode", mode);
    req.headers.set("X-Code", code);
    return stub.fetch(req);
  },
};

export class Room extends DurableObject {
  players(except) {
    const list = [];
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      const a = s.deserializeAttachment();
      if (a) list.push({ id: a.id, name: a.name });
    }
    return list;
  }

  hostId(except) {
    const ids = this.players(except).map((p) => p.id);
    return ids.length ? Math.min(...ids) : 0;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  broadcast(data, except) {
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      try { s.send(data); } catch (e) {}
    }
  }

  async fetch(request) {
    const mode = request.headers.get("X-Mode");
    const code = request.headers.get("X-Code");
    const name = (new URL(request.url).searchParams.get("name") || "Player").slice(0, 16);

    const existing = this.players();
    if (mode === "create" && existing.length > 0) return new Response("room exists", { status: 409 });
    if (mode === "join" && existing.length === 0) return new Response("no such room", { status: 404 });
    if (existing.length >= MAX_PLAYERS) return new Response("room full", { status: 403 });

    const id = existing.length ? Math.max(...existing.map((p) => p.id)) + 1 : 1;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name });

    this.send(server, {
      t: "welcome", code, id,
      host: this.hostId(),
      players: this.players(),
    });
    this.broadcast(JSON.stringify({ t: "join", id, name }), server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    const size = typeof msg === "string" ? msg.length : msg.byteLength;
    if (size > MAX_MSG) return;

    if (typeof msg === "string") {
      let o;
      try { o = JSON.parse(msg); } catch (e) { return; }
      o.from = me.id;
      this.broadcast(JSON.stringify(o), ws);
    } else {
      // ikili paket: ilk bayt gonderen id, gerisi veri
      const out = new Uint8Array(1 + msg.byteLength);
      out[0] = me.id;
      out.set(new Uint8Array(msg), 1);
      this.broadcast(out, ws);
    }
  }

  leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    this.broadcast(JSON.stringify({ t: "leave", id: me.id, host: this.hostId(ws) }), ws);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.leave(ws);
    try { ws.close(code, "bye"); } catch (e) {}
  }

  async webSocketError(ws, error) {
    this.leave(ws);
    try { ws.close(1011, "error"); } catch (e) {}
  }
}
