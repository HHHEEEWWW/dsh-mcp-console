/**
 * dsh-mcp-console — host half.
 *
 * MCP management panel for DeepSeek Harness Web UI:
 *   - Settings → MCP page (client half) to view / add / edit / remove MCP servers
 *   - Two transports per server, matching the official bridge:
 *       • stdio            — local child process (npx / uvx / python ...)
 *       • streamable-http  — remote MCP endpoint URL + static headers
 *   - Backed by the OFFICIAL @deepseek-ai/dsh-mcp-client bridge: each server is
 *     dynamically loaded with `ctx.plugin(mcpClient, config)` and its tools are
 *     registered as `mcp__<serverName>__<rawName>` — hot add / remove / edit,
 *     no process restart (fiber dispose / re-create).
 *   - Import MCP servers from GitHub (claude_desktop_config.json / .mcp.json
 *     / .claude/settings.json format, i.e. `{ mcpServers: { name: {...} } }`).
 *   - Persists server configs at ~/.dsh/mcp-console.json.
 *
 * HTTP surface (mounted on the DSH GUI webserver):
 *   GET  /mcp-console/api/servers                  list servers with live status
 *   POST /mcp-console/api/servers                  add a server (stdio | streamable-http)
 *   PUT  /mcp-console/api/servers/:id              update a server (hot reload)
 *   DEL  /mcp-console/api/servers/:id              remove a server
 *   POST /mcp-console/api/servers/:id/connect      (re)connect
 *   POST /mcp-console/api/servers/:id/disconnect   stop without removing config
 *   POST /mcp-console/api/import/github            probe a GitHub repo / raw URL for MCP configs
 *   POST /mcp-console/api/import/apply             batch-add probed candidates
 *
 * @module dsh-mcp-console
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-mcp-console'
/** Services required by this plugin. webServer is injected dynamically (web-only). */
export const inject = ['tools']

const STATE_PATH = join(homedir(), '.dsh', 'mcp-console.json')
const API_PREFIX = '/mcp-console/api'
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** GitHub config file candidates probed for repo-style URLs. */
const GITHUB_CONFIG_PATHS = [
  '.mcp.json',
  '.claude/settings.json',
  'claude_desktop_config.json',
  '.github/mcp.json',
  'mcp.json',
]

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { servers: [] }
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function cleanName(raw) {
  const cleaned = String(raw || '').trim().replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.slice(0, 32)
}

/** Normalize a claude-style server entry into an official-bridge config. */
export function normalizeCandidate(name, entry) {
  if (!entry || typeof entry !== 'object') return null
  const nm = cleanName(name)
  if (!nm) return null
  if (typeof entry.url === 'string' && entry.url.length > 0) {
    return { name: nm, transport: 'streamable-http', config: { url: entry.url, headers: entry.headers || {} } }
  }
  if (typeof entry.command === 'string' && entry.command.length > 0) {
    return {
      name: nm,
      transport: 'stdio',
      config: {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: entry.env || {},
        cwd: entry.cwd || '',
      },
    }
  }
  return null
}

/** Fetch a URL with an optional GitHub token from the process env. */
async function fetchText(url) {
  const headers = {}
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`)
  return resp.text()
}

/** Parse an MCP config document (claude_desktop_config.json / .mcp.json shape). */
export function parseMcpDocument(text, source) {
  let json
  try {
    json = JSON.parse(text)
  } catch (e) {
    throw new Error(`无法解析 JSON（${source}）: ${e.message}`)
  }
  const servers = json.mcpServers ?? json.mcp_servers ?? json
  if (!servers || typeof servers !== 'object') throw new Error(`未找到 mcpServers 字段（${source}）`)
  const candidates = []
  for (const [rawName, entry] of Object.entries(servers)) {
    const c = normalizeCandidate(rawName, entry)
    if (c) candidates.push(c)
  }
  return candidates
}

/** Probe a GitHub repo URL or a raw file URL for MCP configs. */
export async function probeGithub(url) {
  const trimmed = String(url || '').trim()
  if (!trimmed) throw new Error('请输入 GitHub 仓库或 raw 文件 URL')

  // raw.githubusercontent.com / 其他 http(s) 文件 URL → fetch directly
  if (!/^https:\/\/(raw\.)?github\.com\//.test(trimmed)) {
    throw new Error('仅支持 github.com 仓库 URL 或 raw.githubusercontent.com 文件 URL')
  }

  if (/^https:\/\/raw\.githubusercontent\.com\//.test(trimmed)) {
    const text = await fetchText(trimmed)
    return { source: trimmed, candidates: parseMcpDocument(text, trimmed) }
  }

  // repo URL: https://github.com/owner/repo[/tree/branch] or /blob/<branch>/<path>
  let owner = null
  let repo = null
  let branch = null
  let filePath = null
  const u = new URL(trimmed)
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs.length < 2) throw new Error('无法识别的 GitHub 仓库 URL')
  ;[owner, repo] = segs
  const rest = segs.slice(2)
  if (rest[0] === 'blob' && rest.length >= 3) {
    branch = rest[1]
    filePath = rest.slice(2).join('/')
  } else if (rest[0] === 'tree' && rest.length >= 2) {
    branch = rest[1]
  } else if (rest[0] === 'blob' || rest[0] === 'tree') {
    throw new Error('blob/tree URL 缺少分支名')
  }

  const pathsToTry = filePath ? [filePath] : GITHUB_CONFIG_PATHS
  const base = `https://raw.githubusercontent.com/${owner}/${repo}`
  let lastErr = null
  for (const p of pathsToTry) {
    const rawUrl = branch ? `${base}/${branch}/${p}` : `${base}/HEAD/${p}`
    try {
      const text = await fetchText(rawUrl)
      return { source: rawUrl, candidates: parseMcpDocument(text, rawUrl) }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`在 ${owner}/${repo} 中未找到 MCP 配置文件（尝试了 ${pathsToTry.join(', ')}）：${lastErr?.message || ''}`)
}

export function apply(ctx) {
  const state = loadState()
  /** serverId -> { fiber, status: 'connecting' | 'connected' | 'error', error, errorDetail } */
  const live = new Map()

  /** Extract the full error chain (message <- cause <- cause ...) for diagnostics. */
  function errorChain(e) {
    const parts = []
    let cur = e
    let depth = 0
    while (cur && depth < 8) {
      const msg = (cur && (cur.message || String(cur))) || String(cur)
      if (!parts.includes(msg)) parts.push(msg)
      cur = cur?.cause
      depth += 1
    }
    return parts.join(' <- ')
  }

  /** On win32, translate a bare `npx` command into node.exe + npx-cli.js
   *  (spawn cannot execute npx.cmd without a shell; the official bridge
   *  spawns with shell:false). Detected once and cached. */
  let npxCliPath = null
  function resolveNpxCli() {
    if (npxCliPath !== null) return npxCliPath
    const candidates = []
    try {
      const prefix = spawnSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf8', timeout: 8000 })
      if (prefix.status === 0) candidates.push(join(prefix.stdout.trim(), 'node_modules', 'npm', 'bin', 'npx-cli.js'))
    } catch { /* ignore */ }
    candidates.push('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js')
    for (const c of candidates) {
      if (existsSync(c)) { npxCliPath = c; break }
    }
    npxCliPath = npxCliPath || candidates[0]
    return npxCliPath
  }

  /** Resolve ${VAR} templates in env values against the process environment,
   *  so tokens never need to be stored in mcp-console.json (e.g.
   *  GITHUB_TOKEN: "${GITHUB_TOKEN}"). Unresolvable names stay literal. */
  function resolveEnv(env) {
    const out = {}
    for (const [k, v] of Object.entries(env || {})) {
      if (typeof v === 'string') {
        out[k] = v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, name) => process.env[name] ?? m)
      } else {
        out[k] = v
      }
    }
    return out
  }

  function serverConfig(server) {
    // CRITICAL: the official bridge dispatches on config.transport (createTransport
    // switch) - a missing field yields undefined and SDK connect(undefined) crashes.
    const cfg = { ...server.config, transport: server.transport, serverName: server.name, failOnStartupError: true }
    cfg.env = resolveEnv(cfg.env)
    if (process.platform === 'win32' && server.transport === 'stdio') {
      const base = String(cfg.command || '').split(/[\\/]/).pop().toLowerCase()
      if (base === 'npx' || base === 'npx.cmd') {
        const npxCli = resolveNpxCli()
        ctx.logger.info(`[mcp-console] win32: "${cfg.command}" -> node.exe + ${npxCli}`)
        return { ...cfg, command: process.execPath, args: [npxCli, ...(cfg.args || [])] }
      }
    }
    return cfg
  }

  async function startServer(server) {
    const existing = live.get(server.id)
    if (existing?.fiber) {
      try { existing.fiber.dispose() } catch { /* ignore */ }
    }
    const entry = { fiber: null, status: 'connecting', error: '', errorDetail: '' }
    live.set(server.id, entry)
    try {
      const fiber = ctx.plugin(mcpClient, serverConfig(server))
      entry.fiber = fiber
      await fiber
      entry.status = 'connected'
      ctx.logger.info(`[mcp-console] server "${server.name}" connected`)
    } catch (e) {
      entry.status = 'error'
      entry.error = e?.message || String(e)
      entry.errorDetail = errorChain(e)
      ctx.logger.warn(`[mcp-console] server "${server.name}" failed: ${entry.errorDetail}`)
      if (entry.fiber) {
        try { entry.fiber.dispose() } catch { /* ignore */ }
        entry.fiber = null
      }
    }
  }

  function stopServer(id) {
    const entry = live.get(id)
    if (entry?.fiber) {
      try { entry.fiber.dispose() } catch { /* ignore */ }
    }
    live.delete(id)
  }

  function findServer(id) {
    return state.servers.find((s) => s.id === id)
  }

  function publicStatus() {
    return state.servers.map((s) => {
      const l = live.get(s.id)
      return {
        id: s.id,
        name: s.name,
        transport: s.transport,
        enabled: s.enabled !== false,
        status: s.enabled === false ? 'disabled' : (l?.status || 'stopped'),
        error: l?.error || '',
        errorDetail: l?.errorDetail || '',
        toolPrefix: `mcp__${s.name}__`,
      }
    })
  }

  function addServer(body) {
    const name = cleanName(body.name)
    if (!name) return { ok: false, error: '名称不合法（仅允许字母/数字/下划线/连字符，最长 32）' }
    if (state.servers.some((s) => s.name === name)) return { ok: false, error: `服务器名称 "${name}" 已存在` }
    const transport = body.transport === 'stdio' ? 'stdio' : 'streamable-http'
    const config = body.config && typeof body.config === 'object' ? { ...body.config, transport } : { transport }
    const server = { id: randomUUID(), name, transport, enabled: true, config }
    state.servers.push(server)
    saveState(state)
    startServer(server)
    return { ok: true, server: publicStatus().find((s) => s.id === server.id) }
  }

  function updateServer(id, body) {
    const server = findServer(id)
    if (!server) return { ok: false, error: '服务器不存在' }
    if (body.name) {
      const name = cleanName(body.name)
      if (!name) return { ok: false, error: '名称不合法' }
      if (state.servers.some((s) => s.id !== id && s.name === name)) return { ok: false, error: `服务器名称 "${name}" 已被占用` }
      server.name = name
    }
    if (body.transport === 'stdio' || body.transport === 'streamable-http') server.transport = body.transport
    if (body.config && typeof body.config === 'object') server.config = body.config
    if (typeof body.enabled === 'boolean') server.enabled = body.enabled
    saveState(state)
    stopServer(id)
    if (server.enabled !== false) startServer(server)
    return { ok: true, server: publicStatus().find((s) => s.id === id) }
  }

  function removeServer(id) {
    const idx = state.servers.findIndex((s) => s.id === id)
    if (idx < 0) return { ok: false, error: '服务器不存在' }
    const [removed] = state.servers.splice(idx, 1)
    saveState(state)
    stopServer(removed.id)
    return { ok: true }
  }

  // Load configured servers at startup (async, non-blocking).
  for (const s of state.servers) {
    if (s.enabled !== false) startServer(s)
  }

  // HTTP API (web-only service — inject dynamically so TUI stays happy).
  const webFiber = ctx.inject(['webServer'], (webCtx) => {
    return webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const p = url.pathname
          const m = req.method

          // GET /api/servers
          if (m === 'GET' && p === `${API_PREFIX}/servers`) {
            return sendJson(res, 200, { ok: true, servers: publicStatus() })
          }

          // GET /api/diag — in-process SDK diagnostics (why new Client fails)
          if (m === 'GET' && p === `${API_PREFIX}/diag`) {
            const diag = {}
            try {
              const sdk = await import('@modelcontextprotocol/sdk/client/index.js')
              diag.sdkExports = Object.keys(sdk).sort()
              diag.clientType = typeof sdk.Client
              try {
                const c = new sdk.Client({ name: 'diag', version: '1' }, { capabilities: {} })
                diag.newClientOk = true
                diag.hasOnclose = 'onclose' in c
              } catch (e) {
                diag.newClientOk = false
                diag.newClientError = errorChain(e)
              }
            } catch (e) {
              diag.sdkImportError = errorChain(e)
            }
            return sendJson(res, 200, { ok: true, diag })
          }

          // POST /api/servers
          if (m === 'POST' && p === `${API_PREFIX}/servers`) {
            const body = JSON.parse(await readBody(req) || '{}')
            const r = addServer(body)
            return sendJson(res, r.ok ? 200 : 400, r)
          }

          // POST /api/servers/:id/connect | /disconnect
          let mm = p.match(new RegExp(`^${API_PREFIX}/servers/([^/]+)/(connect|disconnect)$`))
          if (m === 'POST' && mm) {
            const [, id, action] = mm
            const server = findServer(id)
            if (!server) return sendJson(res, 404, { ok: false, error: '服务器不存在' })
            if (action === 'connect') {
              server.enabled = true
              saveState(state)
              startServer(server)
            } else {
              server.enabled = false
              saveState(state)
              stopServer(id)
            }
            return sendJson(res, 200, { ok: true })
          }

          // PUT /api/servers/:id
          mm = p.match(new RegExp(`^${API_PREFIX}/servers/([^/]+)$`))
          if (m === 'PUT' && mm) {
            const body = JSON.parse(await readBody(req) || '{}')
            const r = updateServer(mm[1], body)
            return sendJson(res, r.ok ? 200 : 400, r)
          }

          // DEL /api/servers/:id
          mm = p.match(new RegExp(`^${API_PREFIX}/servers/([^/]+)$`))
          if (m === 'DELETE' && mm) {
            const r = removeServer(mm[1])
            return sendJson(res, r.ok ? 200 : 404, r)
          }

          // POST /api/import/github
          if (m === 'POST' && p === `${API_PREFIX}/import/github`) {
            const body = JSON.parse(await readBody(req) || '{}')
            try {
              const result = await probeGithub(body.url)
              return sendJson(res, 200, { ok: true, ...result })
            } catch (e) {
              return sendJson(res, 400, { ok: false, error: e?.message || String(e) })
            }
          }

          // POST /api/import/apply
          if (m === 'POST' && p === `${API_PREFIX}/import/apply`) {
            const body = JSON.parse(await readBody(req) || '{}')
            const candidates = Array.isArray(body.candidates) ? body.candidates : []
            let added = 0
            const skipped = []
            for (const c of candidates) {
              const r = addServer(c)
              if (r.ok) added += 1
              else skipped.push({ name: c.name, reason: r.error })
            }
            return sendJson(res, 200, { ok: true, added, skipped })
          }

          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e?.message || String(e) })
        }
      },
    }), 'dsh-mcp-console: api routes')
  })

  return () => {
    for (const id of [...live.keys()]) stopServer(id)
    try { webFiber.dispose() } catch { /* ignore */ }
  }
}
