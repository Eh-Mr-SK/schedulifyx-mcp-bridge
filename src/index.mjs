#!/usr/bin/env node
/**
 * SchedulifyX MCP Bridge — a local stdio MCP server that moves media from disk
 * into SchedulifyX without the bytes passing through the model's context.
 *
 * The problem it solves: MCP tool calls are JSON carried in the model's context,
 * so bytes cannot travel through MCP. A 700 KB image is ~240,000 tokens as
 * base64 — the call dies before it is sent. Chunking does not help, because the
 * same bytes still land in the context, only in slices.
 *
 * The transfer therefore has to happen out-of-band, performed by something with
 * both filesystem access and network access. The model has neither. A remote MCP
 * server has the network but not your disk. This process has both, because it
 * runs on your machine over stdio — so the model passes a *path*, and the bytes
 * go straight to storage.
 *
 * It is deliberately thin: it holds no state, stores nothing, and can only talk
 * to SchedulifyX with the token you configured.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createReadStream } from 'node:fs';
import { stat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const BRIDGE_VERSION = '0.1.0';
const API_BASE = process.env.SCHEDULIFYX_API_BASE || 'https://api.schedulifyx.com';
const MCP_URL = `${API_BASE}/mcp`;
const TOKEN = process.env.SCHEDULIFYX_TOKEN || '';

/** Expand a leading ~ so config files can use it. */
function expandHome(p) {
  if (!p) return p;
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

const ALLOWED_DIRS = (process.env.SCHEDULIFYX_ALLOWED_DIRS || '')
  .split(',')
  .map((d) => expandHome(d))
  .filter(Boolean)
  .map((d) => path.resolve(d));

/**
 * Confirm a path sits inside an allowed directory.
 *
 * Resolved through realpath first so a symlink cannot point out of the sandbox,
 * and compared with a trailing separator so `/home/userdata` does not satisfy an
 * allowlist entry of `/home/user`.
 */
async function assertAllowed(inputPath) {
  if (ALLOWED_DIRS.length === 0) {
    throw new Error(
      'SCHEDULIFYX_ALLOWED_DIRS is not set. The bridge refuses to read anything until you list the directories it may read from.'
    );
  }

  const resolved = await realpath(path.resolve(expandHome(inputPath)));

  for (const dir of ALLOWED_DIRS) {
    let realDir;
    try {
      realDir = await realpath(dir);
    } catch {
      continue; // a configured directory that does not exist grants nothing
    }
    if (resolved === realDir || resolved.startsWith(realDir + path.sep)) return resolved;
  }

  throw new Error(
    `Refused: ${inputPath} is outside the allowed directories (${ALLOWED_DIRS.join(', ')}). ` +
    `Add its directory to SCHEDULIFYX_ALLOWED_DIRS if this is intentional.`
  );
}

/** Call a SchedulifyX MCP tool over Streamable HTTP and return its parsed result. */
async function callRemoteTool(name, args = {}) {
  if (!TOKEN) throw new Error('SCHEDULIFYX_TOKEN is not set.');

  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // Identifies calls as coming from the bridge rather than the assistant
      // directly, so the account can tell whether local uploads are available
      // and stop suggesting a browser step to someone who does not need one.
      'User-Agent': `schedulifyx-mcp-bridge/${BRIDGE_VERSION}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SchedulifyX ${name} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);

  // Streamable HTTP may answer as SSE; take the last data: line when it does.
  let payload = text;
  if (text.startsWith('event:') || text.includes('\ndata: ')) {
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    if (dataLines.length) payload = dataLines[dataLines.length - 1].slice(6);
  }

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new Error(`SchedulifyX ${name} returned a non-JSON response: ${payload.slice(0, 200)}`);
  }

  if (json.error) throw new Error(`SchedulifyX ${name} error: ${json.error.message || JSON.stringify(json.error)}`);

  const content = json.result?.content?.find((c) => c.type === 'text')?.text;
  if (!content) throw new Error(`SchedulifyX ${name} returned no result.`);

  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

/**
 * Stream a local file to storage and return its mediaId.
 *
 * Streamed rather than buffered so a 2 GB video costs the same memory as a
 * thumbnail, and duplex:'half' is required for a streaming request body in
 * undici.
 */
async function uploadLocalFile(absPath) {
  const info = await stat(absPath);
  if (!info.isFile()) throw new Error(`${absPath} is not a file.`);

  const session = await callRemoteTool('create_upload_link', {});
  if (!session.directPutUrl || !session.sessionId) {
    throw new Error('SchedulifyX did not return an upload target.');
  }

  if (session.maxBytes && info.size > session.maxBytes) {
    throw new Error(`File is ${info.size} bytes, above the ${session.maxBytes}-byte limit.`);
  }

  const put = await fetch(session.directPutUrl, {
    method: 'PUT',
    body: createReadStream(absPath),
    duplex: 'half',
    headers: { 'Content-Length': String(info.size) },
  });

  if (!put.ok) {
    throw new Error(`Upload failed (HTTP ${put.status}): ${(await put.text()).slice(0, 200)}`);
  }

  // Finalise. The object exists the moment the PUT returns, so a couple of
  // quick attempts covers the write becoming visible without a real wait.
  for (let attempt = 0; attempt < 5; attempt++) {
    const status = await callRemoteTool('get_upload_status', { sessionId: session.sessionId });
    if (status.status === 'completed' && status.mediaId) {
      return { mediaId: status.mediaId, fileName: path.basename(absPath), bytes: info.size };
    }
    if (status.status === 'expired') throw new Error('The upload link expired before it could be finalised.');
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('Upload did not finalise in time. Call get_upload_status with the sessionId to check.');
}

const TOOLS = [
  {
    name: 'stage_file',
    description:
      'Upload ONE local image or video into the SchedulifyX media library and return its mediaId, which you pass to schedule_post as mediaIds. ' +
      'The file is streamed straight to storage, so nothing travels through the context and there is effectively no size limit (up to 10GB). ' +
      'Use this for anything on disk — generator output, a screenshot, a video export. Never base64 a file into another tool instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file. ~ is expanded. Must sit inside an allowed directory.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'stage_latest',
    description:
      'Upload the MOST RECENTLY MODIFIED file in a directory and return its mediaId. ' +
      'Use this straight after an image or video generator (Gemini, Veo, Runway, Sora, ComfyUI) writes its output, when you do not know the ' +
      'filename it chose — which is the usual case. Saves listing the directory and guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to look in. ~ is expanded. Must be an allowed directory.' },
        pattern: { type: 'string', description: "Optional extension filter, e.g. '.mp4' or '.png'." },
      },
      required: ['directory'],
    },
  },
  {
    name: 'stage_url',
    description:
      'Hand a PUBLIC https URL to SchedulifyX to fetch server-side, returning a mediaId. ' +
      'Nothing is read from disk and nothing is downloaded locally. Use this when the media already lives at a URL — a hosted generator result, ' +
      'a CDN asset — in preference to downloading it first.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public https URL of the image or video.' },
        fileName: { type: 'string', description: 'Optional name to store it under.' },
      },
      required: ['url'],
    },
  },
];

const server = new Server(
  { name: 'schedulifyx-bridge', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Moves local media into SchedulifyX without routing bytes through the context window. ' +
      'After any generator writes an image or video to disk, call stage_latest (or stage_file) to get a mediaId, ' +
      'then pass that mediaId to the SchedulifyX schedule_post tool. Do not attempt to base64 large files.',
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === 'stage_file') {
      const abs = await assertAllowed(String(args.path || ''));
      const result = await uploadLocalFile(abs);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    if (name === 'stage_latest') {
      const dir = await assertAllowed(String(args.directory || ''));
      const entries = await readdir(dir, { withFileTypes: true });
      const ext = args.pattern ? String(args.pattern).toLowerCase() : null;

      const candidates = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (ext && !e.name.toLowerCase().endsWith(ext)) continue;
        const full = path.join(dir, e.name);
        candidates.push({ full, mtime: (await stat(full)).mtimeMs });
      }

      if (candidates.length === 0) {
        throw new Error(`No${ext ? ` ${ext}` : ''} files found in ${dir}.`);
      }

      candidates.sort((a, b) => b.mtime - a.mtime);
      const result = await uploadLocalFile(candidates[0].full);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    if (name === 'stage_url') {
      const result = await callRemoteTool('upload_media_from_url', {
        url: String(args.url || ''),
        ...(args.fileName ? { fileName: String(args.fileName) } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the MCP transport and any stray write corrupts it.
process.stderr.write(
  `schedulifyx-bridge ready · api ${API_BASE} · ${ALLOWED_DIRS.length} allowed dir(s)\n`
);
