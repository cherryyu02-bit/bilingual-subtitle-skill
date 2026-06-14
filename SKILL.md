---
name: create-bilingual-subtitles
description: Create bilingual subtitles and subtitled video files from local video or audio. Use when Codex needs to transcribe speech with OpenAI audio models, translate transcript segments with an OpenAI text model such as gpt-5.4, generate SRT/VTT/ASS subtitle files, install or locate ffmpeg when needed, and render burned-in Chinese-English or other bilingual subtitles into MP4 files.
---

# Create Bilingual Subtitles

## Overview

Use this skill to turn a local video or audio file into bilingual subtitle artifacts and, when requested, a rendered video with subtitles burned into the image.

Prefer the bundled script `scripts/create_bilingual_subtitles.mjs` for repeatable work. It calls OpenAI directly with native Node `fetch`, caches transcript and translation JSON, splits long transcript segments into shorter subtitle cues, writes `.srt`, `.vtt`, `.ass`, and can invoke ffmpeg to render a subtitled MP4.

## Workflow

1. Confirm the input media path and desired output languages. Default to Simplified Chinese plus English when the user asks for "Chinese and English subtitles".
2. Use the `openai-platform-api-key` credential gate before making API calls. Never print plaintext API keys.
3. If the user asks for "latest" OpenAI models, use the `openai-docs` skill or official OpenAI docs before choosing model names. Preserve explicit model requests such as `gpt-5.4`.
4. Check for ffmpeg with `ffmpeg -version`. If missing and a rendered video is requested, install a local ffmpeg provider in the working directory after approval, for example `python -m pip install --target ./.codex_deps imageio-ffmpeg`.
5. Run the script from the media working directory. Keep generated artifacts next to the input unless the user asks for an output directory.
6. Verify results: inspect generated file sizes, run ffmpeg over the output MP4 when available, and optionally grab a preview frame that shows subtitles.

## Script Usage

Run with Node 20+:

```bash
node /path/to/create-bilingual-subtitles/scripts/create_bilingual_subtitles.mjs --input Sample.mp4 --burn
```

Common options:

```bash
node scripts/create_bilingual_subtitles.mjs \
  --input Sample.mp4 \
  --target-a "Simplified Chinese" \
  --target-b "English" \
  --transcribe-model gpt-4o-transcribe-diarize \
  --translate-model gpt-5.4 \
  --burn
```

Useful flags:

- `--input <path>`: required media file.
- `--output-dir <path>`: artifact directory; defaults to the input file directory.
- `--basename <name>`: output filename stem; defaults to the input stem.
- `--target-a <language>` and `--target-b <language>`: subtitle languages.
- `--transcribe-model <model>`: default `gpt-4o-transcribe-diarize`.
- `--translate-model <model>`: default `gpt-5.4`.
- `--ffmpeg <path>`: explicit ffmpeg executable.
- `--max-cue-duration <seconds>`: soft cap for each subtitle cue; defaults to `5`.
- `--burn`: render `<basename>.bilingual-subtitled.mp4`.
- `--no-burn`: write subtitle files only.

The script reads `OPENAI_API_KEY` from the environment, `.env.local`, or `.env` in the current directory or input media directory.

## ffmpeg Notes

Use an existing system ffmpeg when available. If not available, install locally rather than globally unless the user asks for a system install.

For Codex desktop on Windows, a reliable local path is:

```powershell
& '<bundled-python>' -m pip install --target .\.codex_deps imageio-ffmpeg
```

If `pip install --target` leaves an incomplete package, download the wheel and extract it into `.codex_deps`; the script can also discover ffmpeg binaries under `.codex_deps`.

## Output Artifacts

For input `Sample.mp4`, expect:

- `Sample.transcript.json`: cached timed transcription.
- `Sample.translations.json`: cached translated segments.
- `Sample.bilingual.srt`: two-line bilingual subtitle cues.
- `Sample.a.srt` and `Sample.b.srt`: single-language subtitle tracks.
- `Sample.bilingual.vtt`: web subtitle format.
- `Sample.bilingual.ass`: styled subtitle format for ffmpeg burning.
- `Sample.bilingual-subtitled.mp4`: rendered output when `--burn` is used.

## Quality Checks

After rendering, run an ffmpeg decode check when available:

```bash
ffmpeg -hide_banner -i Sample.bilingual-subtitled.mp4 -f null -
```

For visual QA, grab a frame during a known subtitle cue:

```bash
ffmpeg -y -ss 00:00:02 -i Sample.bilingual-subtitled.mp4 -frames:v 1 subtitle-preview.png
```

Open or view the preview frame to confirm subtitle placement, wrapping, and readability.
