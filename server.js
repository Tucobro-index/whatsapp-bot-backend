// WhatsApp Bot: API del panel + tu bot en UN solo proceso (CommonJS, igual que tu bot actual)
// Uso: npm install && npm start   (Node 18+)
// IMPORTANTE: apaga tu index.js anterior. Dos procesos con la misma sesión se desconectan entre sí.
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const pino = require("pino");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "Admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "2014";
const ORIGIN = process.env.ORIGIN || "*";        // ej: https://tu-usuario.github.io
const OWNER_JID = process.env.OWNER_JID || "";   // ej: 573001234567@s.whatsapp.net (recibe avisos de error)
const AUTH_DIR = "auth_info_baileys";            // misma carpeta que tu bot: reutiliza su sesión

const app = express();
app.use(cors({ origin: ORIGIN }));
app.use(express.json());

/* ---------- Estado y consola del panel ---------- */
let sock = null, status = "generating", qr = "", startedAt = 0;
const logs = []; let logId = 0;
const log = (msg, level = "") => { logs.push({ id: ++logId, msg, level }); if (logs.length > 300) logs.shift(); console.log(msg); };

function reportarError(origen, err) {
  const m = `⚠️ [ERROR EN ${origen.toUpperCase()}]\n>${err?.message || err}`;
  log(m, "err");
  if (sock && OWNER_JID) sock.sendMessage(OWNER_JID, { text: m }).catch(() => {});
}
process.on("uncaughtException", e => reportarError("uncaughtException", e));
process.on("unhandledRejection", e => reportarError("unhandledRejection", e));

/* ---------- Tus comandos: se cargan desde handlers.js si existe ---------- */
let registerHandlers = () => {};
try { registerHandlers = require("./handlers"); }
catch (e) { if (e.code === "MODULE_NOT_FOUND" && /handlers/.test(e.message)) log("Sin handlers.js: solo vinculación, sin comandos"); else throw e; }

async function connectToWhatsApp() {
  qr = ""; status = "generating";
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],   // misma configuración que ya te funciona
    markOnlineOnConnect: false
  });
  startedAt = Date.now();
  sock.ev.on("creds.update", saveCreds);
  try { registerHandlers(sock, { reportarError, log }); } catch (e) { reportarError("handlers", e); }

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr: newQr }) => {
    if (newQr) { qr = newQr; status = "disconnected"; log("QR listo para escanear"); }
    if (connection === "open") { status = "connected"; qr = ""; log("🟢 WhatsApp conectado", "ok"); }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconectar = code !== DisconnectReason.loggedOut;
      status = "generating"; qr = "";
      log(`⚠️ Conexión cerrada (${code}). Reconectando: ${reconectar}`, reconectar ? "" : "err");
      if (!reconectar) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); // sesión cerrada desde el celular
      setTimeout(connectToWhatsApp, 3000);
    }
  });
}

/* ---------- Autenticación: un solo usuario ---------- */
const tokens = new Set();
const auth = (req, res, next) =>
  tokens.has((req.headers.authorization || "").replace("Bearer ", "")) ? next() : res.status(401).json({ error: "Sesión no válida" });

app.post("/api/login", (req, res) => {
  const { usuario, password } = req.body || {};
  if (usuario !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  const token = crypto.randomBytes(24).toString("hex"); tokens.add(token);
  res.json({ token, usuario: ADMIN_USER, rol: "admin" });
});

app.get("/api/qr", auth, (req, res) => res.json({ status, qr }));
app.get("/api/logs", auth, (req, res) => res.json({ logs: logs.filter(l => l.id > (Number(req.query.since) || 0)) }));

/* Código de emparejamiento: mismo método de tu bot (requestPairingCode tras esperar ~4 s del socket nuevo) */
app.post("/api/pairing", auth, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (phone.length < 8) return res.status(400).json({ error: "Número no válido" });
    if (sock.authState.creds.registered || status === "connected") return res.status(400).json({ error: "El bot ya está vinculado. Cierra la sesión en el celular para vincular otro número" });
    const falta = 4000 - (Date.now() - startedAt);
    if (falta > 0) await new Promise(r => setTimeout(r, falta));
    const code = await sock.requestPairingCode(phone);
    log(`🔑 CÓDIGO DE VINCULACIÓN para +${phone}: ${code?.match(/.{1,4}/g)?.join("-") || code}`, "ok");
    res.json({ code });
  } catch (e) {
    reportarError("requestPairingCode", e);
    res.status(500).json({ error: "No se pudo generar el código. Espera unos segundos y reintenta" });
  }
});

app.get("/", (_, res) => res.send("WhatsApp Bot API activa"));
app.listen(PORT, () => { log("API escuchando en puerto " + PORT); connectToWhatsApp(); });
