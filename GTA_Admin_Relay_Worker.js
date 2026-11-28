import { DurableObject } from "cloudflare:workers";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type,Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function parseId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

function listed(id, raw) {
  return String(raw || "").split(",").map((v) => v.trim()).filter(Boolean).includes(String(id));
}

function adminTokenFor(env, userId) {
  try {
    const map = JSON.parse(String(env.ADMIN_TOKENS || "{}"));
    return map && typeof map === "object" ? String(map[String(userId)] || "") : "";
  } catch {
    return "";
  }
}

function roomFor(env, placeId, jobId) {
  const place = parseId(placeId);
  const job = String(jobId || "").trim();
  if (!place || !job || job.length > 100) return null;
  const roomName = `${place}:${job}`;
  const id = env.GTA_ADMIN_ROOM.idFromName(roomName);
  return env.GTA_ADMIN_ROOM.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (url.pathname === "/api/status" && request.method === "GET") {
      const uid = parseId(url.searchParams.get("uid"));
      if (!uid) return json({ error: "uid inválido" }, 400);
      const ban = await env.GTA_BANS.get(uid, "json");
      let activeBan = ban;
      if (activeBan && activeBan.expiresAt && Math.floor(Date.now() / 1000) >= Number(activeBan.expiresAt)) {
        await env.GTA_BANS.delete(uid);
        activeBan = null;
      }
      let stopped = false;
      const placeId = url.searchParams.get("placeId");
      const jobId = url.searchParams.get("jobId");
      if (placeId && jobId) {
        const stub = roomFor(env, placeId, jobId);
        if (stub) {
          const stopResponse = await stub.fetch(`https://relay.internal/stopped?uid=${encodeURIComponent(uid)}`);
          const stopData = await stopResponse.json().catch(() => ({}));
          stopped = stopData.stopped === true;
        }
      }
      if (activeBan) return json({ ...activeBan, active: true, stopped });
      return json({ active: false, stopped });
    }

    if (url.pathname === "/api/online" && request.method === "GET") {
      const stub = roomFor(env, url.searchParams.get("placeId"), url.searchParams.get("jobId"));
      if (!stub) return json({ error: "servidor inválido" }, 400);
      return stub.fetch("https://relay.internal/online");
    }

    if (url.pathname === "/api/poll" && request.method === "GET") {
      const uid = parseId(url.searchParams.get("uid"));
      const stub = roomFor(env, url.searchParams.get("placeId"), url.searchParams.get("jobId"));
      if (!uid || !stub) return json({ error: "uid/servidor inválido" }, 400);
      const query = new URLSearchParams({
        uid,
        manage: url.searchParams.get("manage") === "1" ? "1" : "0",
        avatar: url.searchParams.get("avatar") === "1" ? "1" : "0",
      });
      const response = await stub.fetch(`https://relay.internal/poll?${query.toString()}`);
      const data = await response.json();
      const ban = await env.GTA_BANS.get(uid, "json");
      if (ban && ban.expiresAt && Math.floor(Date.now() / 1000) >= Number(ban.expiresAt)) {
        await env.GTA_BANS.delete(uid);
        return json({ ...data, ban: null });
      }
      return json({ ...data, ban: ban ? { ...ban, active: true } : null });
    }

    if (url.pathname === "/api/ack" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const uid = body && parseId(body.userId);
      const stub = body && roomFor(env, body.placeId, body.jobId);
      if (!uid || !stub || !body.id) return json({ error: "ack inválido" }, 400);
      return stub.fetch("https://relay.internal/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: uid, id: String(body.id), outcome: String(body.outcome || "done") }),
      });
    }

    if (url.pathname === "/api/command" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "JSON inválido" }, 400);
      const auth = request.headers.get("authorization") || "";
      const issuerId = parseId(body.issuerUserId);
      const targetId = parseId(body.targetUserId);
      if (!issuerId || !targetId) return json({ error: "issuerUserId/targetUserId inválido" }, 400);
      if (!env.ADMIN_USER_IDS || !listed(issuerId, env.ADMIN_USER_IDS)) return json({ error: "issuer não está na allowlist de admins" }, 403);
      const expected = adminTokenFor(env, issuerId);
      if (!expected || auth !== `Bearer ${expected}`) return json({ error: "token individual do administrador inválido" }, 401);
      const ownerId = parseId(env.OWNER_USER_ID);
      if (!ownerId) return json({ error: "configure OWNER_USER_ID válido no Worker antes de usar" }, 503);
      if (targetId === ownerId) return json({ error: "o dono é imune" }, 403);
      if (listed(targetId, env.IMMUNE_USER_IDS)) return json({ error: "alvo imune configurado" }, 403);
      if (listed(targetId, env.ADMIN_USER_IDS) && issuerId !== ownerId) {
        return json({ error: "administradores são protegidos contra comandos de outros administradores" }, 403);
      }
      if (targetId === issuerId) return json({ error: "não é permitido enviar comandos para si mesmo" }, 400);

      const allowed = new Set(["STOP_SCRIPT", "LOCK_TEMP", "LOCK_PERM", "KICK_SELF", "KILL_SELF", "FLING_SELF"]);
      const action = String(body.action || "");
      if (!allowed.has(action)) return json({ error: "ação não permitida" }, 400);

      let durationSeconds = 0;
      if (action === "LOCK_TEMP") {
        durationSeconds = Math.max(60, Math.min(30 * 24 * 60 * 60, Number(body.durationSeconds) || 300));
      }
      const stub = roomFor(env, body.placeId, body.jobId);
      if (!stub) return json({ error: "servidor inválido" }, 400);

      const command = {
        targetUserId: targetId,
        targetName: String(body.targetName || "").slice(0, 40),
        issuerUserId: issuerId,
        issuerName: String(body.issuerName || "").slice(0, 40),
        action,
        reason: String(body.reason || "Admin GTA Hub").slice(0, 180),
        durationSeconds,
      };
      const roomResponse = await stub.fetch("https://relay.internal/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      const roomData = await roomResponse.json().catch(() => ({}));
      if (!roomResponse.ok) return json(roomData, roomResponse.status);

      if (action === "LOCK_TEMP" || action === "LOCK_PERM") {
        const expiresAt = action === "LOCK_TEMP" ? Math.floor(Date.now() / 1000) + durationSeconds : 0;
        const ban = {
          active: true,
          reason: command.reason,
          issuerUserId: issuerId,
          issuerName: command.issuerName,
          expiresAt,
        };
        if (expiresAt > 0) {
          await env.GTA_BANS.put(targetId, JSON.stringify(ban), { expiration: expiresAt });
        } else {
          await env.GTA_BANS.put(targetId, JSON.stringify(ban));
        }
      }
      return json({ ok: true, commandId: roomData.commandId, action, targetUserId: targetId });
    }

    return json({ error: "not found" }, 404);
  },
};

export class RelayRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === "/poll" && request.method === "GET") {
      const uid = parseId(url.searchParams.get("uid"));
      if (!uid) return json({ error: "uid inválido" }, 400);
      const stopKey = `stopped:${uid}`;
      const stoppedAt = Number(await this.ctx.storage.get(stopKey) || 0);
      const stopped = stoppedAt > 0 && now - stoppedAt < 7 * 24 * 60 * 60 * 1000;
      if (stoppedAt > 0 && !stopped) await this.ctx.storage.delete(stopKey);

      const presence = {
        userId: uid,
        manageConsent: !stopped && url.searchParams.get("manage") === "1",
        avatarConsent: !stopped && url.searchParams.get("avatar") === "1",
        seenAt: now,
      };
      await this.ctx.storage.put(`presence:${uid}`, presence);
      const queueKey = `queue:${uid}`;
      const queue = (await this.ctx.storage.get(queueKey)) || [];
      const live = queue.filter((cmd) => Number(cmd.expiresAt || 0) > now);
      // At-most-once delivery: KILL/FLING cannot repeat every polling interval if ACK is unavailable.
      await this.ctx.storage.put(queueKey, []);
      return json({ commands: stopped ? [] : live, stopped });
    }

    if (url.pathname === "/stopped" && request.method === "GET") {
      const uid = parseId(url.searchParams.get("uid"));
      if (!uid) return json({ error: "uid inválido" }, 400);
      const key = `stopped:${uid}`;
      const stoppedAt = Number(await this.ctx.storage.get(key) || 0);
      const stopped = stoppedAt > 0 && now - stoppedAt < 7 * 24 * 60 * 60 * 1000;
      if (stoppedAt > 0 && !stopped) await this.ctx.storage.delete(key);
      return json({ stopped });
    }

    if (url.pathname === "/online" && request.method === "GET") {
      const stored = await this.ctx.storage.list({ prefix: "presence:" });
      const players = [];
      for (const [key, value] of stored) {
        if (!value || now - Number(value.seenAt || 0) > 25000) {
          await this.ctx.storage.delete(key);
          continue;
        }
        if (value.manageConsent === true) {
          players.push({
            userId: Number(value.userId),
            avatarConsent: value.avatarConsent === true,
          });
        }
      }
      return json({ players });
    }

    if (url.pathname === "/enqueue" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "JSON inválido" }, 400);
      const uid = parseId(body.targetUserId);
      if (!uid) return json({ error: "alvo inválido" }, 400);
      const presenceKey = `presence:${uid}`;
      const presence = await this.ctx.storage.get(presenceKey);
      if (!presence || now - Number(presence.seenAt || 0) > 25000) return json({ error: "alvo não está online com o GTA Hub neste servidor" }, 409);
      const needsAvatar = ["KICK_SELF", "KILL_SELF", "FLING_SELF"].includes(body.action);
      if (needsAvatar ? presence.avatarConsent !== true : presence.manageConsent !== true) {
        return json({ error: needsAvatar ? "alvo não consentiu com ações no personagem" : "alvo não consentiu com gestão do script" }, 403);
      }
      const command = {
        ...body,
        id: crypto.randomUUID(),
        issuedAt: now,
        expiresAt: now + 10 * 60 * 1000,
      };
      if (body.action === "STOP_SCRIPT") {
        await this.ctx.storage.put(`stopped:${uid}`, now);
        await this.ctx.storage.put(presenceKey, { ...presence, manageConsent: false, avatarConsent: false, seenAt: now });
      }
      const queueKey = `queue:${uid}`;
      const queue = (await this.ctx.storage.get(queueKey)) || [];
      queue.push(command);
      await this.ctx.storage.put(queueKey, queue.slice(-50));
      return json({ ok: true, commandId: command.id });
    }

    if (url.pathname === "/ack" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const uid = body && parseId(body.userId);
      if (!uid || !body.id) return json({ error: "ack inválido" }, 400);
      const queueKey = `queue:${uid}`;
      const queue = (await this.ctx.storage.get(queueKey)) || [];
      await this.ctx.storage.put(queueKey, queue.filter((cmd) => String(cmd.id) !== String(body.id)));
      return json({ ok: true, outcome: String(body.outcome || "done") });
    }

    return json({ error: "not found" }, 404);
  }
}
