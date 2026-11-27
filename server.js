const express = require("express");
const { spawn } = require("child_process");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.set("trust proxy", 1); // อยู่หลัง proxy ของ Render ให้ได้ IP ผู้ใช้จริง
app.use(express.json());

// ---------- CORS ----------
// ตั้งค่า ALLOWED_ORIGIN ใน Render (Environment) เช่น https://เว็บคุณ.com
// ถ้าไม่ตั้ง จะอนุญาตทุกเว็บ
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- ป้องกัน: รับเฉพาะ http/https และห้ามชี้เข้าเครือข่ายภายใน ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("ลิงก์ไม่ถูกต้อง"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("รองรับเฉพาะ http/https");
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("ลิงก์นี้ไม่อนุญาต");
  return u.toString();
}

// ---------- จำกัดจำนวนครั้งต่อ IP ----------
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 60000);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
}, 60000);

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 20) return res.status(429).json({ error: "ใช้งานถี่เกินไป รอสักครู่" });
  arr.push(now);
  hits.set(ip, arr);
  next();
}

// ---------- ปลุกเซิร์ฟเวอร์ / เช็กสถานะ ----------
app.get("/", (req, res) => res.json({ ok: true, service: "video-downloader-api" }));
app.get("/api/ping", (req, res) => res.json({ ok: true }));

// ---------- ดึงข้อมูลวิดีโอ ----------
app.post("/api/info", rateLimit, async (req, res) => {
  try {
    const url = await validateUrl(req.body && req.body.url);
    const p = spawn("yt-dlp", ["-J", "--no-playlist", "--no-warnings", "--", url]);
    let out = "", err = "", done = false;

    const finish = (status, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res.status(status).json(body);
    };

    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(504, { error: "ใช้เวลานานเกินไป ลองใหม่อีกครั้ง" });
    }, 30000);

    p.on("error", () => finish(500, { error: "เซิร์ฟเวอร์ไม่พบ yt-dlp" }));
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) {
        console.error("yt-dlp info error:", err.slice(-500));
        return finish(422, { error: "ดึงข้อมูลไม่ได้ (ลิงก์นี้อาจไม่รองรับ ถูกบล็อก หรือเป็นคอนเทนต์ที่ป้องกันไว้)" });
      }
      try {
        const j = JSON.parse(out);
        const heights = [...new Set((j.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
        finish(200, {
          title: j.title || "video",
          thumbnail: j.thumbnail || null,
          duration: j.duration || null,
          uploader: j.uploader || null,
          heights,
        });
      } catch {
        finish(500, { error: "อ่านข้อมูลไม่สำเร็จ" });
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- ดาวน์โหลด (สตรีมตรงถึงผู้ใช้) ----------
app.get("/api/download", rateLimit, async (req, res) => {
  try {
    const url = await validateUrl(req.query.url);
    const quality = String(req.query.quality || "best");
    const title = String(req.query.title || "video").replace(/[^\p{L}\p{N}\-_ ]/gu, "").slice(0, 80) || "video";

    let format, ext, mime;
    if (quality === "audio") {
      format = "ba[ext=m4a]/ba/b"; ext = "m4a"; mime = "audio/mp4";
    } else if (/^\d+$/.test(quality)) {
      format = `b[ext=mp4][height<=${quality}]/b[height<=${quality}]/b`; ext = "mp4"; mime = "video/mp4";
    } else {
      format = "b[ext=mp4]/b"; ext = "mp4"; mime = "video/mp4";
    }

    const p = spawn("yt-dlp", ["-f", format, "--no-playlist", "--no-warnings", "-o", "-", "--", url]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(title)}.${ext}`);

    p.stdout.pipe(res);
    p.on("error", () => { if (!res.headersSent) res.status(500).send("เซิร์ฟเวอร์ไม่พบ yt-dlp"); else res.end(); });
    p.on("close", (code) => {
      if (code !== 0) console.error("yt-dlp download error:", err.slice(-500));
    });
    res.on("close", () => p.kill("SIGKILL"));
  } catch (e) {
    res.status(400).send(e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on port " + PORT));
