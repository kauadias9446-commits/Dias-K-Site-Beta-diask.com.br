const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_COOKIE = "dias_k_session";

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRateLimited(clientKey) {
  const now = Date.now();
  const recentRequests = (requestsByClient.get(clientKey) || [])
    .filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  recentRequests.push(now);
  requestsByClient.set(clientKey, recentRequests);
  return recentRequests.length > RATE_LIMIT_MAX_REQUESTS;
}

function encodeBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeBase64(new Uint8Array(digest));
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  return cookies.split(";").map((cookie) => cookie.trim().split("=")).find(([key]) => key === name)?.[1] || null;
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=None`;
}

async function createSession(userId, env) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = encodeBase64(tokenBytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt, now.toISOString()).run();
  return { token, expiresAt };
}

async function handleAuth(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: "Autenticação ainda não configurada no servidor." }, 503, corsHeaders);
  const path = new URL(request.url).pathname;
  const action = path.split("/").filter(Boolean).at(-1);
  if (action === "session") {
    const token = getCookie(request, SESSION_COOKIE);
    if (!token) return jsonResponse({ error: "Sessão não encontrada." }, 401, corsHeaders);
    const user = await env.DB.prepare("SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?")
      .bind(await hashToken(token), new Date().toISOString()).first();
    return user
      ? jsonResponse({ user }, 200, corsHeaders)
      : jsonResponse({ error: "Sessão expirada." }, 401, { ...corsHeaders, "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None` });
  }
  if (action === "logout") {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    return new Response(null, { status: 204, headers: { ...corsHeaders, "Set-Cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None` } });
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "JSON inválido." }, 400, corsHeaders); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
    return jsonResponse({ error: "Informe um e-mail válido e uma senha de 8 a 128 caracteres." }, 400, corsHeaders);
  }

  const existing = await env.DB.prepare("SELECT id, email, password_hash, password_salt FROM users WHERE email = ?").bind(email).first();
  if (action === "signup") {
    if (existing) return jsonResponse({ error: "Este e-mail já possui uma conta." }, 409, corsHeaders);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordHash = await hashPassword(password, salt);
    const user = { id: crypto.randomUUID(), email };
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, user.email, encodeBase64(passwordHash), encodeBase64(salt), new Date().toISOString()).run();
    const session = await createSession(user.id, env);
    return jsonResponse({ user }, 201, { ...corsHeaders, "Set-Cookie": sessionCookie(session.token) });
  }

  if (action !== "login" || !existing) return jsonResponse({ error: "E-mail ou senha não conferem." }, 401, corsHeaders);
  const expected = decodeBase64(existing.password_hash);
  const actual = await hashPassword(password, decodeBase64(existing.password_salt));
  const matches = expected.length === actual.length && expected.every((byte, index) => byte === actual[index]);
  if (!matches) return jsonResponse({ error: "E-mail ou senha não conferem." }, 401, corsHeaders);
  const session = await createSession(existing.id, env);
  return jsonResponse({ user: { id: existing.id, email: existing.email } }, 200, { ...corsHeaders, "Set-Cookie": sessionCookie(session.token) });
}

async function getSessionUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !env.DB) return null;
  return env.DB.prepare("SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?")
    .bind(await hashToken(token), new Date().toISOString()).first();
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    const requestOrigin = request.headers.get("Origin");
    if (allowedOrigin !== "*" && requestOrigin && requestOrigin !== allowedOrigin) {
      return jsonResponse({ error: "Origem não autorizada." }, 403, corsHeaders);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Método não permitido." }, 405, corsHeaders);
    }

    if (new URL(request.url).pathname.startsWith("/auth/")) {
      return handleAuth(request, env, corsHeaders);
    }

    if (env.REQUIRE_AUTH === "true" && !(await getSessionUser(request, env))) {
      return jsonResponse({ error: "Entre na sua conta para continuar." }, 401, corsHeaders);
    }

    return jsonResponse({ error: "A conversa automática foi desativada." }, 410, corsHeaders);
  },
};
