// JWT (HS256) + scrypt password hashing + role-based authorisation, using only node:crypto.
const crypto = require("crypto");
const config = require("./config");

const ROLES = ["public", "citizen", "researcher", "operator", "admin"];
const b64u = (b) => Buffer.from(b).toString("base64url");

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split("$");
  if (!saltHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

function sign(payload) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + config.jwtTtlSeconds };
  const data = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify(body))}`;
  return `${data}.${crypto.createHmac("sha256", config.jwtSecret).update(data).digest("base64url")}`;
}

function verify(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", config.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (expected.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  const body = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

/** Returns the authenticated user ({ id, email, role }) or a public principal. */
function principal(req) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  const body = t && verify(t);
  return body ? { id: body.sub, email: body.email, role: body.role, name: body.name } : { id: null, role: "public" };
}

const atLeast = (user, role) => ROLES.indexOf(user.role) >= ROLES.indexOf(role);

module.exports = { ROLES, hashPassword, checkPassword, sign, verify, principal, atLeast };
