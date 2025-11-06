// server.js - tour.ia complete backend
import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { OpenAI } from "openai";
import xss from "xss";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

// Security HTTP headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS - allow origins from env or localhost
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET","POST","DELETE","OPTIONS"]
}));

// Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, try again later." }
});
app.use(limiter);

// JSON body
app.use(express.json({ limit: "300kb" }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Data files
const HISTORY_FILE = path.join(__dirname, "data", "history.json");
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "[]", "utf8");

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8") || "[]");
  } catch (e) {
    console.error("readHistory error", e);
    return [];
  }
}
function writeHistory(arr) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("writeHistory error", e);
  }
}
function hashIp(ip) {
  return crypto.createHash("sha256").update(ip || "unknown").digest("hex");
}
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress;
}

// In-memory cache for banner and trending (refresh once a day)
let bannerCache = { date: null, text: null };
let trendingCache = { date: null, list: null };

function startOfDayString() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString();
}

// Endpoint: POST /api/plan  (form mode) - uses gpt-3.5-turbo (fast) and returns itinerary with images
app.post("/api/plan", async (req, res) => {
  try {
    const allowed = ["destination","days","budget","interests","group"];
    const bodyKeys = Object.keys(req.body || {});
    if (!bodyKeys.every(k => allowed.includes(k))) return res.status(400).json({ error: "Invalid fields" });

    // sanitize
    for (const k of bodyKeys) if (typeof req.body[k] === "string") req.body[k] = xss(req.body[k].trim());

    const { destination, days, budget, interests, group } = req.body;
    if (!destination) return res.status(400).json({ error: "Destination required" });

    // Build prompt for gpt-3.5-turbo
    const prompt = `Eres un asistente que crea itinerarios concisos en español.
Genera un itinerario en JSON para un viaje a "${destination}"${days ? " de " + days + " días" : ""}${group ? " pensado para " + group : ""}${budget ? " con presupuesto: " + budget : ""}${interests ? " centrado en: " + interests : ""}.
Salida JSON:
{
  "summary": "texto corto",
  "itinerary": [
    {"day": 1, "date": "YYYY-MM-DD", "summary":"", "activities":[ {"time":"Mañana","title":"","desc":""} ] }
  ]
}
Incluye además una propiedad "images" con una lista de URLs relevantes (usa Unsplash pattern). Responde SOLO con JSON válido.`;

    const completion = await openai.chat.completions.create({
      model: process.env.FORM_MODEL || "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 700
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: "No response from model" });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // fallback: attempt to extract JSON substring
      const m = text.match(/\{[\s\S]*\}$/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch(err) {
          return res.status(500).json({ error: "Model output not valid JSON", raw: text });
        }
      } else return res.status(500).json({ error: "Model output not valid JSON", raw: text });
    }

    // add Unsplash images if not present (client-side also uses Unsplash)
    if (!parsed.images || !Array.isArray(parsed.images) || parsed.images.length === 0) {
      parsed.images = [`https://source.unsplash.com/800x500/?${encodeURIComponent(destination)}`];
    }

    // Save to history hashed by IP
    const ip = getClientIp(req);
    const h = hashIp(ip);
    const history = readHistory();
    const entry = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8),
      userHash: h,
      timestamp: new Date().toISOString(),
      request: { destination, days, budget, interests, group },
      response: parsed
    };
    history.push(entry);
    writeHistory(history);

    res.json(parsed);
  } catch (err) {
    console.error("/api/plan error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint: POST /api/chat  (chat mode) - uses gpt-4o-mini (more capable)
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, group } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });

    // sanitize messages
    const sanitized = messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? xss(m.content) : "" }));

    const system = { role: "system", content: `Eres un asistente de viajes profesional. Si el usuario menciona un destino y pide un itinerario, genera un JSON compacto que pueda guardarse en el historial.` + (group ? " Contexto del grupo: " + group : "") };

    const conversation = [system, ...sanitized];

    const completion = await openai.chat.completions.create({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: conversation,
      temperature: 0.8,
      max_tokens: 900
    });

    const text = completion.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: "No response from model" });

    // respond raw text (client handles display). Also try to parse JSON to save to history if present.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch(e) { parsed = null; }

    // if parsed contains itinerary, save to history
    if (parsed && parsed.itinerary) {
      const ip = getClientIp(req);
      const h = hashIp(ip);
      const history = readHistory();
      const entry = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8),
        userHash: h,
        timestamp: new Date().toISOString(),
        request: { chat: true, group, snippet: sanitized.slice(-1)[0]?.content || "" },
        response: parsed
      };
      history.push(entry);
      writeHistory(history);
    }

    res.json({ text, parsed });
  } catch (err) {
    console.error("/api/chat error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/history?page=&limit=  - returns history for requester (by hash) with pagination
app.get("/api/history", (req, res) => {
  try {
    const ip = getClientIp(req);
    const h = hashIp(ip);
    const page = Math.max(1, parseInt(req.query.page||"1"));
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit||"10")));

    const history = readHistory().filter(it => it.userHash === h).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = history.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page-1)*limit;
    const results = history.slice(start, start+limit);

    res.json({ page, totalPages, total, results });
  } catch (err) {
    console.error("/api/history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/history/:id
app.delete("/api/history/:id", (req, res) => {
  try {
    const id = req.params.id;
    const ip = getClientIp(req);
    const h = hashIp(ip);
    let history = readHistory();
    const idx = history.findIndex(it => it.id === id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    if (history[idx].userHash !== h) return res.status(403).json({ error: "Not authorized" });
    history.splice(idx,1);
    writeHistory(history);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE history error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/trending - compute top destinations globally for the day (cache daily)
app.get("/api/trending", (req, res) => {
  try {
    const today = startOfDayString();
    if (trendingCache.date === today && trendingCache.list) return res.json({ results: trendingCache.list });

    const history = readHistory();
    const counts = {};
    history.forEach(it => {
      const dest = (it.request && (it.request.destination || (it.request.chat && it.response?.summary))) || null;
      if (dest) {
        // normalize simple
        const key = String(dest).toLowerCase().trim().split(",")[0];
        counts[key] = (counts[key]||0) + 1;
      }
    });
    const sorted = Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).slice(0,20);
    const list = sorted.map(k => ({ name: k.charAt(0).toUpperCase()+k.slice(1), tag: k }));
    trendingCache = { date: today, list };
    res.json({ results: list.slice(0,10) });
  } catch (err) {
    console.error("/api/trending error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/banner - generates a neutral-elegant banner phrase daily using the IA (cached)
app.get("/api/banner", async (req, res) => {
  try {
    const today = startOfDayString();
    if (bannerCache.date === today && bannerCache.text) return res.json({ text: bannerCache.text });

    const prompt = `Genera en español una frase corta (máx 10-12 palabras), en tono neutro y elegante, sobre viajar o descubrir el mundo. No uses emojis. Devuelve solo la frase.`;
    const completion = await openai.chat.completions.create({
      model: process.env.CHAT_MODEL || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 40
    });
    const text = completion.choices?.[0]?.message?.content?.trim() || "Explora nuevos destinos con confianza y curiosidad.";
    bannerCache = { date: today, text };
    res.json({ text });
  } catch (err) {
    console.error("/api/banner error", err);
    // fallback default
    res.json({ text: "Explora nuevos destinos con confianza y curiosidad." });
  }
});

// Fallback - serve SPA
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`tour.ia listening on http://localhost:${port}`);
});
