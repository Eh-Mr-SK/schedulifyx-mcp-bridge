# SchedulifyX MCP Bridge

Gets images and videos from your own machine into SchedulifyX, automatically,
without a browser and without the file passing through the AI's context window.

## Why this exists

MCP tool calls are JSON that flows through the model's context. Bytes therefore
cannot travel through MCP — a 700 KB image is roughly 240,000 tokens as base64,
which exhausts the context window before the call is even sent. Chunking does
not help: the same bytes still pass through the context, just in slices.

So the file has to move out-of-band, and something with **both** filesystem
access and network access has to move it. That is never the model, and for a
remote MCP server it cannot be the server either — it has no access to your
disk.

This bridge is that something. It runs locally over stdio, so it can read a path
you give it and upload the bytes itself. Only the path and the resulting media
ID ever reach the model — a few dozen tokens instead of a quarter of a million.

## What it unlocks

The case this is built for is chaining one MCP server to another:

```
Gemini / Veo / Runway / Sora writes an image or video to disk
        ↓
stage_latest("~/generated-images")     ← this bridge, ~40 tokens
        ↓  returns a mediaId
schedule_post(content, mediaIds: [...])  ← SchedulifyX, remote
```

Before this, that chain was only possible in clients that can run shell commands
(Claude Code can; Claude Desktop and Cursor cannot). Now it works anywhere that
can launch a local MCP server.

## Install

Add it alongside the remote SchedulifyX server. In Claude Desktop's
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "schedulifyx": {
      "url": "https://api.schedulifyx.com/mcp",
      "headers": { "Authorization": "Bearer sxm_your_token" }
    },
    "schedulifyx-bridge": {
      "command": "npx",
      "args": ["-y", "@schedulifyx/mcp-bridge"],
      "env": {
        "SCHEDULIFYX_TOKEN": "sxm_your_token",
        "SCHEDULIFYX_ALLOWED_DIRS": "~/Pictures,~/Downloads,~/generated-images"
      }
    }
  }
}
```

Use the same token for both. The bridge acts as you, with exactly the access
that token has — including any brand and social-account limits set on it.

## Tools

| Tool | What it does |
| --- | --- |
| `stage_file(path)` | Uploads one file and returns its `mediaId`. |
| `stage_latest(directory, pattern?)` | Uploads the newest matching file in a directory. Use this after a generator writes a file whose name you do not know. |
| `stage_url(url)` | Hands a public URL to SchedulifyX to fetch server-side. No local read. |

Each returns a `mediaId` to pass to `schedule_post` as `mediaIds`.

## Security

`SCHEDULIFYX_ALLOWED_DIRS` is required and is the boundary: the bridge reads
only from inside those directories. Paths are resolved to their real location
before the check, so a symlink or `..` cannot escape, and every upload goes to
SchedulifyX with your token and nowhere else.

Set the narrowest set of directories that covers your generators' output.

## Limits

Up to 10 GB per file. Files are streamed to storage, so memory use stays flat
regardless of size.

The one case this cannot fix is a host that can neither run a local server nor
reach your disk — ChatGPT's web connectors, for instance. There the browser
drop-link from `create_upload_link` remains the only route, and no vendor has
solved that, because MCP has no byte channel outside the model's context.
