#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, openAsBlob, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaults = {
  targetA: "Simplified Chinese",
  targetB: "English",
  transcribeModel: "gpt-4o-transcribe-diarize",
  translateModel: "gpt-5.4",
};

function usage() {
  return `Usage:
  node create_bilingual_subtitles.mjs --input <media> [--burn]

Options:
  --input <path>                 Required video/audio file
  --output-dir <path>            Defaults to input directory
  --basename <name>              Defaults to input filename stem
  --target-a <language>          Defaults to Simplified Chinese
  --target-b <language>          Defaults to English
  --transcribe-model <model>     Defaults to gpt-4o-transcribe-diarize
  --translate-model <model>      Defaults to gpt-5.4
  --ffmpeg <path>                Explicit ffmpeg executable
  --max-cue-duration <seconds>   Defaults to 5
  --burn                         Render burned-in MP4
  --no-burn                      Only write subtitle files
  --help                         Show this help`;
}

function parseArgs(argv) {
  const args = {
    input: null,
    outputDir: null,
    basename: null,
    targetA: defaults.targetA,
    targetB: defaults.targetB,
    transcribeModel: defaults.transcribeModel,
    translateModel: defaults.translateModel,
    ffmpeg: process.env.FFMPEG_PATH || null,
    maxCueDuration: 5,
    burn: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--input" || arg === "-i") {
      args.input = next();
    } else if (arg === "--output-dir") {
      args.outputDir = next();
    } else if (arg === "--basename") {
      args.basename = next();
    } else if (arg === "--target-a") {
      args.targetA = next();
    } else if (arg === "--target-b") {
      args.targetB = next();
    } else if (arg === "--transcribe-model") {
      args.transcribeModel = next();
    } else if (arg === "--translate-model") {
      args.translateModel = next();
    } else if (arg === "--ffmpeg") {
      args.ffmpeg = next();
    } else if (arg === "--max-cue-duration") {
      args.maxCueDuration = Number(next());
    } else if (arg === "--burn") {
      args.burn = true;
    } else if (arg === "--no-burn") {
      args.burn = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error("--input is required");
  args.input = resolve(args.input);
  if (!existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);
  args.outputDir = resolve(args.outputDir || dirname(args.input));
  args.basename = args.basename || basename(args.input, extname(args.input));
  if (!Number.isFinite(args.maxCueDuration) || args.maxCueDuration <= 0) {
    throw new Error("--max-cue-duration must be a positive number");
  }
  mkdirSync(args.outputDir, { recursive: true });
  return args;
}

function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
    if (match) return match[1].replace(/^['"]|['"]$/g, "").trim();
  }
  return null;
}

function loadApiKey(inputPath) {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  for (const dir of [process.cwd(), dirname(inputPath)]) {
    for (const name of [".env.local", ".env"]) {
      const key = readEnvFile(join(dir, name));
      if (key) return key;
    }
  }
  throw new Error("OPENAI_API_KEY was not found in env, .env.local, or .env.");
}

async function openaiFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 2000)}`);
  return JSON.parse(text);
}

function responseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function artifactPaths(args) {
  const p = (suffix) => join(args.outputDir, `${args.basename}${suffix}`);
  return {
    transcript: p(".transcript.json"),
    translations: p(".translations.json"),
    srtBilingual: p(".bilingual.srt"),
    srtA: p(".a.srt"),
    srtB: p(".b.srt"),
    vtt: p(".bilingual.vtt"),
    ass: p(".bilingual.ass"),
    mp4: p(".bilingual-subtitled.mp4"),
  };
}

function normalizeSegments(transcript) {
  const raw = transcript.segments ?? transcript.speaker_segments ?? [];
  const segments = raw
    .map((segment, index) => ({
      index: index + 1,
      start: Number(segment.start ?? segment.start_time ?? 0),
      end: Number(segment.end ?? segment.end_time ?? 0),
      speaker: segment.speaker ?? segment.speaker_label ?? "",
      text: String(segment.text ?? segment.transcript ?? "").trim(),
    }))
    .filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end));
  if (segments.length) return segments;

  const text = String(transcript.text ?? "").trim();
  if (!text) throw new Error("Transcription response had no timed segments or text.");
  return [{ index: 1, start: 0, end: 5, speaker: "", text }];
}

async function transcribe(apiKey, args, paths) {
  if (existsSync(paths.transcript)) {
    console.log(`Using cached transcription: ${basename(paths.transcript)}`);
    return JSON.parse(readFileSync(paths.transcript, "utf8"));
  }

  const blob = await openAsBlob(args.input);
  const form = new FormData();
  form.append("file", blob, basename(args.input));
  form.append("model", args.transcribeModel);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

  console.log(`Transcribing with ${args.transcribeModel}...`);
  const transcript = await openaiFetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  writeFileSync(paths.transcript, JSON.stringify(transcript, null, 2), "utf8");
  return transcript;
}

async function translate(apiKey, args, paths, segments) {
  if (existsSync(paths.translations)) {
    console.log(`Using cached translations: ${basename(paths.translations)}`);
    return JSON.parse(readFileSync(paths.translations, "utf8"));
  }

  const source = segments.map(({ index, speaker, text }) => ({ index, speaker, text }));
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "integer" },
            a: { type: "string" },
            b: { type: "string" },
          },
          required: ["index", "a", "b"],
        },
      },
    },
    required: ["segments"],
  };

  const prompt =
    `Translate these transcript segments for subtitles. Target A: ${args.targetA}. Target B: ${args.targetB}. ` +
    "Keep text concise and natural. Preserve names, numbers, intent, and tone. Return JSON with the same indexes.\n" +
    JSON.stringify(source);

  const body = {
    model: args.translateModel,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content:
          "You are a careful subtitle translator. Produce subtitle-ready text only, not commentary.",
      },
      { role: "user", content: prompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "bilingual_subtitle_segments",
        schema,
        strict: true,
      },
    },
  };

  console.log(`Translating with ${args.translateModel}...`);
  let data;
  try {
    data = await openaiFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (!String(error.message).includes("400")) throw error;
    const fallback = { ...body };
    delete fallback.text;
    fallback.input[1].content +=
      '\nReturn only JSON: {"segments":[{"index":1,"a":"...","b":"..."}]}';
    data = await openaiFetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fallback),
    });
  }

  const parsed = JSON.parse(responseText(data));
  writeFileSync(paths.translations, JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const centi = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centi).padStart(2, "0")}`;
}

function displayLength(text) {
  return Array.from(String(text)).reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1.6 : 1), 0);
}

function wrap(text, maxLen = 42) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  const words = compact.split(" ");
  if (words.length === 1) {
    const chars = Array.from(compact);
    const lines = [];
    for (let i = 0; i < chars.length; i += maxLen) lines.push(chars.slice(i, i + maxLen).join(""));
    return lines.join("\n");
  }
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) line = word;
    else if ((line + " " + word).length <= maxLen) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function splitSentences(text) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (!compact) return [""];
  const matches = compact.match(/[^。！？!?；;.!?]+[。！？!?；;.!?]*/g);
  return (matches?.map((part) => part.trim()).filter(Boolean) ?? [compact]);
}

function chunkByCharacters(text, parts) {
  const chars = Array.from(text);
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    const start = Math.round((i * chars.length) / parts);
    const end = Math.round(((i + 1) * chars.length) / parts);
    chunks.push(chars.slice(start, end).join("").trim());
  }
  return chunks;
}

function chunkByWords(text, parts) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return chunkByCharacters(text, parts);
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < parts; i++) {
    const remainingWords = words.length - cursor;
    const remainingParts = parts - i;
    const take = Math.max(1, Math.round(remainingWords / remainingParts));
    chunks.push(words.slice(cursor, cursor + take).join(" "));
    cursor += take;
  }
  return chunks;
}

function splitTextEvenly(text, parts) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (parts <= 1 || !compact) return [compact];

  const sentences = splitSentences(compact);
  if (sentences.length >= parts) {
    const chunks = [];
    let cursor = 0;
    for (let i = 0; i < parts; i++) {
      const remainingSentences = sentences.length - cursor;
      const remainingParts = parts - i;
      const take = Math.max(1, Math.round(remainingSentences / remainingParts));
      chunks.push(sentences.slice(cursor, cursor + take).join(" ").trim());
      cursor += take;
    }
    return chunks;
  }

  if (/\s/.test(compact)) return chunkByWords(compact, parts);
  return chunkByCharacters(compact, parts);
}

function subtitleLayout(args) {
  const size = args.videoSize ?? { width: 1920, height: 1080 };
  const portrait = size.height > size.width;
  return {
    playResX: size.width,
    playResY: size.height,
    fontSize: portrait ? 34 : 46,
    outline: portrait ? 2.4 : 3,
    shadow: portrait ? 0.8 : 1,
    marginL: portrait ? 54 : 80,
    marginR: portrait ? 54 : 80,
    marginV: portrait ? 120 : 72,
    wrapA: portrait ? 18 : 34,
    wrapB: portrait ? 26 : 46,
    maxAChars: portrait ? 30 : 52,
    maxBChars: portrait ? 68 : 100,
  };
}

function expandCues(args, merged) {
  const layout = subtitleLayout(args);
  const cues = [];
  for (const segment of merged) {
    const duration = Math.max(0.1, segment.end - segment.start);
    const maxByDuration = Math.max(1, Math.ceil(duration / args.maxCueDuration));
    const maxByA = Math.max(1, Math.ceil(displayLength(segment.a) / layout.maxAChars));
    const maxByB = Math.max(1, Math.ceil(displayLength(segment.b) / layout.maxBChars));
    const capByDuration = Math.max(1, Math.floor(duration / 1.15));
    const wantedParts = Math.max(maxByDuration, maxByA, maxByB);
    const parts = Math.max(1, Math.min(12, capByDuration, wantedParts));
    const aParts = splitTextEvenly(segment.a, parts);
    const bParts = splitTextEvenly(segment.b, parts);

    for (let i = 0; i < parts; i++) {
      cues.push({
        ...segment,
        index: cues.length + 1,
        start: segment.start + (duration * i) / parts,
        end: segment.start + (duration * (i + 1)) / parts,
        a: aParts[i] ?? "",
        b: bParts[i] ?? "",
      });
    }
  }
  return cues;
}

function assEscape(text) {
  return String(text).replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

function writeSubtitleFiles(args, paths, segments, translations) {
  const layout = subtitleLayout(args);
  const byIndex = new Map(translations.segments.map((segment) => [Number(segment.index), segment]));
  const merged = segments.map((segment) => {
    const translated = byIndex.get(segment.index) ?? {};
    return {
      ...segment,
      a: String(translated.a ?? translated.zh ?? segment.text).trim(),
      b: String(translated.b ?? translated.en ?? segment.text).trim(),
    };
  });
  const cues = expandCues(args, merged);

  const cue = (segment, lines) =>
    `${segment.index}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${lines.join("\n")}\n`;

  writeFileSync(paths.srtBilingual, cues.map((segment) => cue(segment, [wrap(segment.a, layout.wrapA), wrap(segment.b, layout.wrapB)])).join("\n"), "utf8");
  writeFileSync(paths.srtA, cues.map((segment) => cue(segment, [wrap(segment.a, layout.wrapA)])).join("\n"), "utf8");
  writeFileSync(paths.srtB, cues.map((segment) => cue(segment, [wrap(segment.b, layout.wrapB)])).join("\n"), "utf8");

  const vtt =
    "WEBVTT\n\n" +
    cues
      .map((segment) => `${srtTime(segment.start).replace(",", ".")} --> ${srtTime(segment.end).replace(",", ".")}\n${wrap(segment.a, layout.wrapA)}\n${wrap(segment.b, layout.wrapB)}\n`)
      .join("\n");
  writeFileSync(paths.vtt, vtt, "utf8");

  const ass = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
PlayResX: ${layout.playResX}
PlayResY: ${layout.playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,${layout.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H7A000000,0,0,0,0,100,100,0,0,1,${layout.outline},${layout.shadow},2,${layout.marginL},${layout.marginR},${layout.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues
  .map((segment) => `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Default,,0,0,0,,${assEscape(wrap(segment.a, layout.wrapA))}\\N${assEscape(wrap(segment.b, layout.wrapB))}`)
  .join("\n")}
`;
  writeFileSync(paths.ass, ass, "utf8");
  return cues;
}

function executableWorks(exe) {
  const result = spawnSync(exe, ["-version"], { encoding: "utf8" });
  return result.status === 0;
}

function walkForFfmpeg(root, depth = 0) {
  if (!existsSync(root) || depth > 5) return null;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isFile() && /^ffmpeg.*(\.exe)?$/i.test(entry)) return path;
    if (st.isDirectory()) {
      const found = walkForFfmpeg(path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findFfmpeg(args) {
  if (args.ffmpeg) {
    const path = resolve(args.ffmpeg);
    if (!existsSync(path)) throw new Error(`ffmpeg not found: ${path}`);
    return path;
  }
  if (executableWorks("ffmpeg")) return "ffmpeg";
  const candidates = [
    join(process.cwd(), ".codex_deps"),
    join(args.outputDir, ".codex_deps"),
    join(dirname(args.input), ".codex_deps"),
  ];
  for (const root of candidates) {
    const found = walkForFfmpeg(root);
    if (found) return found;
  }
  throw new Error("ffmpeg not found. Install ffmpeg or pass --ffmpeg <path>.");
}

function filterPath(path) {
  return resolve(path).replace(/\\/g, "/").replace(/:/, "\\:");
}

function probeVideoSize(ffmpeg, input) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", input], { encoding: "utf8" });
  const text = `${result.stderr}\n${result.stdout}`;
  const match = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!match) return { width: 1920, height: 1080 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function burnVideo(args, paths, ffmpeg) {
  ffmpeg = ffmpeg || findFfmpeg(args);
  console.log("Rendering subtitled MP4 with ffmpeg...");
  const result = spawnSync(
    ffmpeg,
    [
      "-y",
      "-i",
      args.input,
      "-vf",
      `ass='${filterPath(paths.ass)}'`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      paths.mp4,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed:\n${result.stderr || result.stdout}`);
}

const args = parseArgs(process.argv.slice(2));
const paths = artifactPaths(args);
const apiKey = loadApiKey(args.input);
const transcript = await transcribe(apiKey, args, paths);
const segments = normalizeSegments(transcript);
console.log(`Timed segments: ${segments.length}`);
const translations = await translate(apiKey, args, paths, segments);
const ffmpeg = args.burn ? findFfmpeg(args) : null;
if (ffmpeg) args.videoSize = probeVideoSize(ffmpeg, args.input);
writeSubtitleFiles(args, paths, segments, translations);
if (args.burn) burnVideo(args, paths, ffmpeg);
console.log("Done.");
