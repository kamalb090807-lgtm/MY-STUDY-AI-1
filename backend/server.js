
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

// server.js (updated - drop-in replacement for your original file)
// NOTE: This file preserves your original structure and endpoints but
// adds: PDF extraction (optional), image-provider wiring (Gemini-support), file QA endpoint,
// serverStart detection for frontend, improved upload metadata & chunking.
// Install optional dependency: `npm install pdf-parse` to enable PDF text extraction.


import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as tesseract from 'node-tesseract-ocr';

let Groq;
try {
  // dynamic import so process won't crash if package missing
  Groq = (await import("groq-sdk")).default;
} catch (e) {
  Groq = null;
  console.warn("Groq SDK not installed or failed to load. Install with: npm install groq-sdk");
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Multer setup */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`)
});
const upload = multer({ storage });

const app = express();
app.use(cors());
// increased limits for file metadata / longer prompts
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

/* Optional pdf-parse import (soft) */
let pdfParse = null;
try {
  pdfParse = (await import('pdf-parse')).default;
} catch (e) {
  pdfParse = null;
  console.warn("pdf-parse not installed. Install with: npm install pdf-parse to enable PDF text extraction.");
}

/* Groq client init (if key present) */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant"; // default recommended
let groqClient = null;

if (Groq && GROQ_API_KEY) {
  try {
    groqClient = new Groq({ apiKey: GROQ_API_KEY });
    console.log("Groq SDK loaded.");
  } catch (e) {
    console.warn("Failed to create Groq client:", e?.message || e);
    groqClient = null;
  }
} else {
  if (!Groq) console.warn("Groq SDK missing. npm install groq-sdk");
  if (!GROQ_API_KEY) console.warn("GROQ_API_KEY missing in .env");
}

/* ----------------------
   Helpers
   ---------------------- */

/**
 * getChatResponse(prompt, opts)
 * - returns {ok:true, text, raw} or throws
 */
async function getChatResponse(prompt, opts = {}) {
  if (!groqClient) {
    const msg = "Groq client not configured. Set GROQ_API_KEY in .env and install groq-sdk";
    throw new Error(msg);
  }

  // model selection (from env or opts)
  const model = opts.model || process.env.GROQ_MODEL || GROQ_MODEL;

  try {
    const response = await groqClient.chat.completions.create({
      model,
      messages: [
        { role: "system", content: opts.system || "You are a helpful study assistant. Keep answers clear and avoid raw TeX unless requested." },
        { role: "user", content: prompt }
      ],
      max_tokens: opts.max_tokens || 900,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.35
    });

    const out = response?.choices?.[0]?.message?.content;
    if (out) return { ok: true, text: String(out), raw: response };

    // fallback to stringify
    return { ok: true, text: JSON.stringify(response), raw: response };
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("Groq call error:", msg);
    throw new Error(`Groq error: ${msg}`);
  }
}

function extractAndParseJson(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    // Attempt to find JSON within markdown code blocks
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
        try {
            return JSON.parse(codeBlockMatch[1]);
        } catch (e) {
            // Ignore if parsing fails, will try next method
        }
    }

    // Attempt to find the first '{' or '[' and parse from there
    const firstBracket = text.indexOf('{');
    const firstSquareBracket = text.indexOf('[');

    let start = -1;

    if (firstBracket === -1 && firstSquareBracket === -1) {
        return null;
    }

    if (firstBracket === -1) {
        start = firstSquareBracket;
    } else if (firstSquareBracket === -1) {
        start = firstBracket;
    } else {
        start = Math.min(firstBracket, firstSquareBracket);
    }
    
    let jsonString = text.substring(start);
    // Attempt to find the matching closing bracket
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        // If parsing fails, try to find the last bracket
        const lastBracket = jsonString.lastIndexOf('}');
        const lastSquareBracket = jsonString.lastIndexOf(']');
        const end = Math.max(lastBracket, lastSquareBracket);

        if (end !== -1) {
            jsonString = jsonString.substring(0, end + 1);
            try {
                return JSON.parse(jsonString);
            } catch (e) {
                return null;
            }
        }
    }

    return null;
}

/* ----------------------
   Server start timestamp (helps frontend detect restarts)
   ---------------------- */
const SERVER_START_TS = Date.now();

/* ----------------------
   Routes
   ---------------------- */

app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    provider: groqClient ? "Groq" : "none",
    model: process.env.GROQ_MODEL || null,
    serverStart: SERVER_START_TS
  });
});

/* POST /api/ai */
app.post("/api/ai", async (req, res) => {
  try {
    // Accept flags: detailed (bool), latex (bool), stepByStep (bool), difficulty ("beginner"|"intermediate"|"expert"), and optional max_tokens/temperature
    const { prompt, model, max_tokens, temperature, detailed, latex, stepByStep, difficulty } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: "Missing prompt in body" });
    }

    if (!groqClient) {
      return res.status(500).json({ ok: false, error: "No AI provider configured. Set GROQ_API_KEY in .env and install groq-sdk." });
    }

    const lower = prompt.toLowerCase();
    const isMCQ = lower.includes('mcq') || lower.includes('multiple choice') || /\bchoose\b|\boption\b|\b(a|b|c|d)\b/i.test(lower);
    const isOneMark = lower.includes('one mark') || lower.includes('one-mark') || /answer only|final answer only/.test(lower);

    let useDetailed = detailed;
    if (typeof useDetailed !== 'boolean') {
      useDetailed = /detailed|explain in detail|long answer|very big|one and half page|one and a half page/i.test(prompt);
    }

    // Build wrapper prompt according to flags and heuristics
    let wrapperPrompt = '';

    // Force MCQ / one-line answers
    if (isMCQ || isOneMark) {
      wrapperPrompt = "Provide only the final short answer (single line) with no explanation. Question: " + prompt;
    } else if (useDetailed) {
      // Detailed long-form answer requested
      // use higher token budget by passing max_tokens when calling getChatResponse
      wrapperPrompt = "You are a professional tutor. Provide a detailed, step-by-step answer with clear explanations, relevant examples, and where appropriate, mathematical derivations. Use LaTeX for equations if requested. Answer the user's prompt exactly:\n\n" + prompt;
    } else {
      // Default answer: reasonably detailed but concise
      wrapperPrompt = "You are a professional patient tutor. Provide a clear, structured answer with headings, short paragraphs, bullets where useful, and one worked example if applicable. Use LaTeX for math only if the user requests it. Make the answer engaging by using emojis and bolding important words. Answer the user's prompt exactly:\n\n" + prompt;
    }

    // If latex explicitly requested, add instruction to output LaTeX and wrap math in $$ for display
    if (latex || /latex|\\\$\\\$|\\\$\s*\\\$/.test(prompt)) {
      wrapperPrompt = "You are a professional tutor. Provide answers using LaTeX for all mathematical expressions. Use display math with $$...$$ for important equations and inline $...$ where appropriate. Output raw LaTeX (do not HTML-escape backslashes). Answer the user's prompt in detail:\n\n" + prompt;
    }

    // If step-by-step explicitly requested, prefer stepwise pedagogy
    if (stepByStep) {
      wrapperPrompt = "You are a step-by-step teacher. For the following prompt, provide a clear stepwise solution:\n\n" + prompt;
    }

    // Difficulty adjustments (overrides wrapper style)
    if (difficulty && typeof difficulty === 'string') {
      const d = String(difficulty).toLowerCase();
      if (d === 'beginner' || d === 'easy') wrapperPrompt = "Explain the following in beginner-friendly terms, with simple examples and no assumed advanced knowledge:\n\n" + prompt;
      else if (d === 'intermediate' || d === 'medium') wrapperPrompt = "Explain the following with intermediate depth: include necessary formulas and one worked example:\n\n" + prompt;
      else if (d === 'expert' || d === 'hard') wrapperPrompt = "Explain the following at an advanced level: include rigorous derivations and concise statements for an expert audience:\n\n" + prompt;
    }

    // Decide token budget
    const tokens = (detailed || latex || /one and half page|one and a half page/i.test(prompt)) ? (max_tokens || 1500) : (max_tokens || 900);

    const result = await getChatResponse(wrapperPrompt, { model, max_tokens: tokens, temperature });

    return res.json({ ok: true, text: result.text, raw: result.raw });
  } catch (err) {
    console.error("API /api/ai error:", err?.message || err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* POST /api/image - Stable Diffusion Image Generation */
app.post("/api/image", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: "Missing prompt" });

    const STABILITY_API_KEY = process.env.STABILITY_API_KEY;

    if (!STABILITY_API_KEY) {
      return res.status(501).json({ ok: false, error: "Image generation not configured. Set STABILITY_API_KEY in .env" });
    }

    console.log("Starting image generation with prompt:", prompt);

    const url = "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image";

    const payload = {
      text_prompts: [
        {
          text: prompt,
          weight: 1
        }
      ],
      output_format: "png"
    };

    console.log("Sending request to Stability API...");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STABILITY_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!r.ok) {
      try {
        const txt = await r.text();
        console.error("Stability API error status:", r.status);
        console.error("Stability API error body:", txt);
        return res.status(502).json({ ok: false, error: "Stability API error: " + txt, status: r.status });
      } catch (e) {
        console.error("Stability API error status:", r.status);
        return res.status(502).json({ ok: false, error: "Stability API error", status: r.status });
      }
    }

    try {
      const j = await r.json();
      console.log("Stability response received successfully");

      // Extract base64 from Stable Diffusion response
      if (j?.artifacts && j.artifacts[0]?.base64) {
        const b64 = j.artifacts[0].base64;
        const dataUrl = `data:image/png;base64,${b64}`;
        console.log("Image generated successfully");
        return res.json({ ok: true, dataUrl, raw: j });
      }

      console.error("Unexpected response format:", JSON.stringify(j));
      return res.status(502).json({ ok: false, error: "Unexpected response format from Stable Diffusion", raw: j });
    } catch (e) {
        console.error("Error parsing Stability API response:", e.message || e);
        return res.status(500).json({ ok: false, error: "Error parsing Stability API response: " + (e.message || String(e)) });
    }
  } catch (err) {
    console.error("Image generation error:", err.message || err);
    return res.status(500).json({ ok: false, error: "Error: " + (err.message || String(err)) });
  }
});

/* POST /api/upload - file field name 'file'
   Behavior:
   - saves file to uploads dir (same as before)
   - attempts to extract text for .txt, .md, .csv, .json, and .pdf (if pdf-parse installed)
   - creates a .meta.json alongside the file containing chunked extracted text for simple file QA
*/
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field 'file')" });

    const fullPath = req.file.path;
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    let extractedText = "";

    // text-like files
    if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".csv") {
      try {
        extractedText = fs.readFileSync(fullPath, { encoding: "utf8" });
      } catch (e) {
        extractedText = "";
      }
    } else if (ext === ".pdf" && pdfParse) {
      try {
        const dataBuffer = fs.readFileSync(fullPath);
        const pdfData = await pdfParse(dataBuffer);
        extractedText = pdfData?.text || "";
      } catch (e) {
        console.warn("PDF parse failed:", e?.message || e);
      }
    } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
      try {
        console.log(`Performing OCR on image: ${fullPath}`);
        extractedText = await tesseract.recognize(fullPath, { lang: 'eng', oem: 1, psm: 3 });
        console.log(`OCR successful for: ${fullPath}`);
      } catch (e) {
        console.error(`Tesseract OCR failed for ${fullPath}:`, e?.message || e);
        extractedText = "";
      }
    } else {
      // for other binaries we currently don't perform OCR
      extractedText = "";
    }

    // chunk the extracted text for retrieval
    const chunks = [];
    if (extractedText && extractedText.trim().length > 0) {
      const paragraphs = extractedText.split(/\n{1,}/).map(s => s.trim()).filter(Boolean);
      let chunkId = 0;
      for (const p of paragraphs) {
        if (p.length <= 1000) {
          chunks.push({ id: `${Date.now()}_${chunkId++}`, text: p });
        } else {
          for (let i = 0; i < p.length; i += 800) {
            chunks.push({ id: `${Date.now()}_${chunkId++}`, text: p.slice(i, i + 800) });
          }
        }
      }
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const meta = {
      id,
      originalName: req.file.originalname,
      filename: req.file.filename,
      path: fullPath,
      size: req.file.size,
      mimeType: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
      chunks
    };

    const metaPath = path.join(UPLOAD_DIR, `${req.file.filename}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    // --- Begin change: Immediately process OCR text if available ---
    let aiResponse = null;
    if (extractedText && extractedText.trim().length > 0 && groqClient) {
      try {
        const prompt = `The following text was extracted from an uploaded file. Please analyze it and provide a helpful response:\n\n---\n\n${extractedText}`;
        const result = await getChatResponse(prompt, { system: "You are a helpful study assistant analyzing a document." });
        aiResponse = result.text;
      } catch (aiError) {
        console.error("Error getting immediate AI response after upload:", aiError);
        // Don't fail the whole upload, just log the error. The user can still query the file later.
      }
    }
    // --- End change ---

    return res.json({ ok: true, meta, aiResponse });
  } catch (err) {
    console.error("/api/upload error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* POST /api/file-qa
   body: { fileFilename: '<stored-filename>', question: '...' }
   Behavior: loads <filename>.meta.json, selects top chunks by keyword matching,
   constructs a prompt with context and forwards to Groq. Returns assistant text and used chunks preview.
*/
app.post("/api/file-qa", async (req, res) => {
  try {
    const { fileFilename, question } = req.body || {};
    if (!fileFilename || !question) return res.status(400).json({ ok: false, error: "Missing fileFilename or question" });

    const metaPath = path.join(UPLOAD_DIR, `${fileFilename}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ ok: false, error: "File metadata not found" });

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const chunks = meta.chunks || [];

    // basic keyword scoring
    const words = question.toLowerCase().split(/\W+/).filter(Boolean);
    const scores = chunks.map(c => {
      const txt = (c.text || "").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (w.length < 3) continue;
        const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const found = (txt.match(re) || []).length;
        score += found;
      }
      return { chunk: c, score };
    });

    scores.sort((a,b) => b.score - a.score);
    const selected = scores.filter(s => s.score > 0).slice(0,6).map(s => s.chunk);
    if (!selected.length) selected.push(...chunks.slice(0,4));

    const contextText = selected.map((c,i) => `Context ${i+1}:\n${c.text}`).join("\n\n---\n\n");
    const prompt = `You are a helpful study assistant. Use the following extracted content from a user's uploaded file to answer the question. If the answer cannot be found in the context, say "I cannot find the answer in the provided document." Keep answers concise unless asked to explain.\n\n${contextText}\n\nQuestion: ${question}\n\nAnswer:`;

    if (!groqClient) return res.status(500).json({ ok: false, error: "Groq client not configured" });
    const result = await getChatResponse(prompt, { system: "You are a helpful study assistant.", max_tokens: 900 });
    return res.json({ ok: true, text: result.text, raw: result.raw, usedChunks: selected.map(s=>({ id: s.id, preview: s.text.slice(0,200) })) });
  } catch (err) {
    console.error("/api/file-qa error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ----------------------
   New: Study Planner endpoint
   POST /api/planner
   body: { history?: string, preferPomodoro?: boolean }
   Returns: JSON with suggested timers, breaks, revision schedule, switchSubjectAfterMinutes, motivationalLines
   ---------------------- */
app.post('/api/planner', async (req, res) => {
  try {
    const { history, preferPomodoro } = req.body || {};
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `You are an expert study planner. Given the user's study history and preferences, return ONLY a valid JSON object (no text before or after) with: \n` +
      `- timers: an array of {name, durationMinutes, startAfterMinutes} \n` +
      `- nextBreakInMinutes: integer, reviseInDays: integer, switchSubjectAfterMinutes: integer, motivationalLines: array of strings (3) \n` +
      `Prefer Pomodoro if preferPomodoro is true (25/5 style). Use user's history to personalize suggestions.\n\nUser history:\n${history || 'No history provided.'}`;

    const result = await getChatResponse(prompt, { system: 'Study planner', max_tokens: 600, temperature: 0.2 });
    const text = String(result.text || '');
    
    const parsed = extractAndParseJson(text);
    
    if (parsed) {
      return res.json({ ok: true, planner: parsed, raw: result.raw });
    } else {
      console.error('/api/planner error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: text });
    }
  } catch (err) {
    console.error('/api/planner error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ----------------------
   New: Personalized Syllabus Generator
   POST /api/syllabus
   body: { course: 'Anna University 3rd sem CSE', weeks?: number }
   Returns: JSON with syllabus, roadmap, weeklySchedule, expectedQuestions
   ---------------------- */
app.post('/api/syllabus', async (req, res) => {
  try {
    const { course, weeks } = req.body || {};
    if (!course || typeof course !== 'string') return res.status(400).json({ ok: false, error: 'Missing course field' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `You are an educational planner. For the course description: "${course}", produce ONLY a valid JSON object (no text before or after) containing:\n` +
      `- syllabus: an ordered list of topics (with short descriptions),\n` +
      `- roadmap: milestones and objectives,\n` +
      `- weeklySchedule: an array of week objects with topics to cover per week (for ${weeks || 12} weeks),\n` +
      `- expectedQuestions: for each major topic, 3 exam-style expected questions.`;

    const result = await getChatResponse(prompt, { system: 'Syllabus generator', max_tokens: 1200, temperature: 0.2 });
    const text = String(result.text || '');
    
    const parsed = extractAndParseJson(text);
    
    if (parsed) {
      return res.json({ ok: true, syllabus: parsed, raw: result.raw });
    } else {
      console.error('/api/syllabus error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: text });
    }
  } catch (err) {
    console.error('/api/syllabus error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ----------------------
   New: Voice Tutor / Quiz endpoints
   POST /api/voice/start-quiz   -> { subject, difficulty, count }
   POST /api/voice/evaluate     -> { question, userAnswer, correctAnswer }
   ---------------------- */
app.post('/api/voice/start-quiz', async (req, res) => {
  try {
    const { subject, difficulty, count } = req.body || {};
    if (!subject) return res.status(400).json({ ok: false, error: 'Missing subject' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `Create ${count || 5} verbal quiz questions for subject: ${subject}. For each question, provide: id, questionText, options (A-D) and correctOption. Output as JSON array.`;
    const result = await getChatResponse(prompt, { system: 'Quiz generator', max_tokens: 800, temperature: 0.3 });
    const text = String(result.text || '');
    
    const parsed = extractAndParseJson(text);

    if (parsed) return res.json({ ok: true, quiz: parsed, raw: result.raw });
    console.error('/api/voice/start-quiz error: Failed to parse JSON from AI response');
    return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: text });
  } catch (err) {
    console.error('/api/voice/start-quiz error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post('/api/voice/evaluate', async (req, res) => {
  try {
    const { question, userAnswer, correctAnswer } = req.body || {};
    if (!question) return res.status(400).json({ ok: false, error: 'Missing question' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    // Ask model to evaluate userAnswer vs correctAnswer and give score + feedback
    const prompt = `Evaluate the user's answer. Question: "${question}". Correct answer: "${correctAnswer}". User answer: "${userAnswer}". Provide a JSON object: {score:0-1, feedback: string, hints: [..]}.`;
    const result = await getChatResponse(prompt, { system: 'Answer evaluator', max_tokens: 300, temperature: 0.2 });
    const text = String(result.text || '');
    
    const parsed = extractAndParseJson(text);

    if (parsed) return res.json({ ok: true, evaluation: parsed, raw: result.raw });
    console.error('/api/voice/evaluate error: Failed to parse JSON from AI response');
    return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: text });
  } catch (err) {
    console.error('/api/voice/evaluate error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ----------------------
   New: Assignment Integrity Checker
   POST /api/assignment-check (multipart 'file' or body { text })
   Returns: JSON with highlights: confusingParts, incorrectMath, missingAssumptions, mistakes
   ---------------------- */
app.post('/api/assignment-check', upload.single('file'), async (req, res) => {
  try {
    let text = req.body && req.body.text ? req.body.text : '';
    if (req.file && !text) {
      // attempt to OCR if image/pdf
      const ext = path.extname(req.file.filename || '').toLowerCase();
      if (ext === '.pdf' && pdfParse) {
        try {
          const dataBuffer = fs.readFileSync(req.file.path);
          const pdfData = await pdfParse(dataBuffer);
          text = pdfData?.text || '';
        } catch (e) { text = ''; }
      } else {
        // try tesseract for images
        try {
          text = await tesseract.recognize(req.file.path, { lang: 'eng', oem: 1, psm: 3 });
        } catch (e) { text = ''; }
      }
    }

    if (!text) return res.status(400).json({ ok: false, error: 'No text to analyze' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `You are an expert grader. Analyze the following student assignment and return JSON with keys: confusingParts (list of excerpts), incorrectMath (list with location and correction), missingAssumptions (list), mistakesInReasoning (list). Output JSON only.\n\nAssignment text:\n${text}`;
    const result = await getChatResponse(prompt, { system: 'Assignment checker', max_tokens: 1200, temperature: 0.2 });
    const out = String(result.text || '');
    
    const parsed = extractAndParseJson(out);

    if (parsed) { 
      return res.json({ ok: true, result: parsed, raw: result.raw }); 
    } else { 
      console.error('/api/assignment-check error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: out });
    }
  } catch (err) { console.error('/api/assignment-check error:', err); return res.status(500).json({ ok: false, error: String(err) }); }
});

/* ----------------------
   New: Topic Relationship Map
   POST /api/topic-map { topic }
   Returns JSON with prerequisites, nextTopics, realWorldApplications
   ---------------------- */
app.post('/api/topic-map', async (req, res) => {
  try {
    const { topic } = req.body || {};
    if (!topic) return res.status(400).json({ ok: false, error: 'Missing topic' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `Produce a topic relationship map for the topic: "${topic}". Output JSON: {prerequisites: [...], whatToLearnNext: [...], realWorldApplications:[...], keyConcepts:[...] }`;
    const result = await getChatResponse(prompt, { system: 'Topic mapper', max_tokens: 800, temperature: 0.2 });
    const out = String(result.text || '');

    const parsed = extractAndParseJson(out);

    if (parsed) {
      return res.json({ ok: true, map: parsed, raw: result.raw }); 
    } else { 
      console.error('/api/topic-map error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: out });
    }
  } catch (err) { console.error('/api/topic-map error:', err); return res.status(500).json({ ok: false, error: String(err) }); }
});

/* ----------------------
   New: Real-time text analyzer
   POST /api/realtime-analyze { text }
   Returns JSON with suggestedFormulas, relatedConcepts, predictedNextQuestion
   ---------------------- */
app.post('/api/realtime-analyze', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'Missing text' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const prompt = `As a real-time study assistant, given the partial user input: "${text}", return JSON with: suggestedFormulas (short list), relatedConcepts (short list), predictedNextQuestion (one-line). Output JSON only.`;
    const result = await getChatResponse(prompt, { system: 'Realtime analyzer', max_tokens: 300, temperature: 0.1 });
    const out = String(result.text || '');

    const parsed = extractAndParseJson(out);
    
    if (parsed) { 
      return res.json({ ok: true, analysis: parsed, raw: result.raw }); 
    } else { 
      console.error('/api/realtime-analyze error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: out });
    }
  } catch (err) { console.error('/api/realtime-analyze error:', err); return res.status(500).json({ ok: false, error: String(err) }); }
});

/* ----------------------
   New: Summarize Entire Chat
   POST /api/summarize-chat { messages: [{from,text}, ...] }
   Returns JSON with keyPoints, importantFormulas, revisionSheet
   ---------------------- */
app.post('/api/summarize-chat', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'Missing messages array' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    const convoText = messages.map(m => `${m.from === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
    const prompt = `Summarize the following chat. Output JSON with: keyPoints (list), importantFormulas (list), revisionSheet (short actionable list). Output JSON only.\n\n${convoText}`;
    const result = await getChatResponse(prompt, { system: 'Chat summarizer', max_tokens: 800, temperature: 0.1 });
    const out = String(result.text || '');

    const parsed = extractAndParseJson(out);

    if (parsed) {
      return res.json({ ok: true, summary: parsed, raw: result.raw }); 
    } else { 
      console.error('/api/summarize-chat error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: out });
    }
  } catch (err) { console.error('/api/summarize-chat error:', err); return res.status(500).json({ ok: false, error: String(err) }); }
});

/* ----------------------
   New: Smart File-to-Quiz Generator
   POST /api/file-quiz { fileFilename }
   Uses existing meta chunks to build MCQs/TF/short answers
   ---------------------- */
app.post('/api/file-quiz', async (req, res) => {
  try {
    const { fileFilename } = req.body || {};
    if (!fileFilename) return res.status(400).json({ ok: false, error: 'Missing fileFilename' });
    const metaPath = path.join(UPLOAD_DIR, `${fileFilename}.meta.json`);
    if (!fs.existsSync(metaPath)) return res.status(404).json({ ok: false, error: 'File metadata not found' });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const chunks = meta.chunks || [];
    if (!chunks.length) return res.status(400).json({ ok: false, error: 'No extracted text available' });
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });

    // build context from chunks
    const contextText = chunks.slice(0,6).map((c,i)=>`Context ${i+1}: ${c.text}`).join('\n\n');
    const prompt = `Create a quiz from the following extracted content. Output JSON with keys: mcq: [{question, options:[A,B,C,D], answer}], tf: [{q, answer}], short: [{q, answer}]. Use source snippets as context where relevant.\n\n${contextText}`;
    const result = await getChatResponse(prompt, { system: 'File quiz generator', max_tokens: 1200, temperature: 0.3 });
    const out = String(result.text || '');

    const parsed = extractAndParseJson(out);
    
    if (parsed) { 
      return res.json({ ok: true, quiz: parsed, raw: result.raw }); 
    } else { 
      console.error('/api/file-quiz error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: out });
    }
  } catch (err) { console.error('/api/file-quiz error:', err); return res.status(500).json({ ok: false, error: String(err) }); }
});

/* ----------------------
   New: Handwritten note beautifier (OCR)
   POST /api/ocr-beautify (multipart/form-data field 'file')
   Uses node-tesseract-ocr to extract text, then calls the AI to clean, highlight mistakes and summarize.
   ---------------------- */
app.post('/api/ocr-beautify', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded (field 'file')" });
    const imgPath = req.file.path;

    // OCR with tesseract (node-tesseract-ocr)
    const config = { lang: 'eng', oem: 1, psm: 3 };
    let ocrText = '';
    try {
      ocrText = await tesseract.recognize(imgPath, config);
    } catch (e) {
      console.error('Tesseract OCR failed:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'OCR failed: ' + String(e?.message || e) });
    }

    // Call AI to beautify handwritten notes: clean, correct mistakes, highlight, summarize
    if (!groqClient) return res.status(500).json({ ok: false, error: 'AI provider not configured' });
    const prompt = `You are a notes beautifier. The user uploaded a handwritten page. Clean and convert the text to well-structured typed notes. Provide: {cleanedNotes: string, corrections: [{original, corrected, reason}], summary: string, highlights: [strings]}. Output JSON only.\n\nHandwritten OCR raw text:\n${ocrText}`;

    const result = await getChatResponse(prompt, { system: 'Handwritten note beautifier', max_tokens: 1200, temperature: 0.2 });
    const text = String(result.text || '');
    
    const parsed = extractAndParseJson(text);

    if (parsed) {
      return res.json({ ok: true, result: parsed, raw: result.raw });
    } else {
      console.error('/api/ocr-beautify error: Failed to parse JSON from AI response');
      return res.status(500).json({ ok: false, error: 'Failed to parse JSON from AI response', aillm_response: text });
    }
  } catch (err) {
    console.error('/api/ocr-beautify error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/* serve uploads */
app.use("/uploads", express.static(path.resolve(UPLOAD_DIR)));

/* start server */
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (!groqClient) {
    console.log("Note: Groq client not configured. Set GROQ_API_KEY in .env and install groq-sdk to enable /api/ai.");
  } else {
    console.log("Groq client ready. Model:", process.env.GROQ_MODEL || "default");
  }

  // Informational: list current upload dir size/count (helpful)
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    console.log(`Uploads directory (${UPLOAD_DIR}) contains ${files.length} entries.`);
  } catch (e) { /* ignore */ }
});
