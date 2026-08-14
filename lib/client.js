window.__ModuleLoader__.load({
	id: "dsh-mcp-console",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const createElement = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useCallback = react.useCallback;

		const inject = ["slots"];

		// ---- styles (injected once) ----
		const css = [
			".mcx_section{display:flex;flex-direction:column;gap:16px;padding:0 24px 24px}",
			".mcx_meta{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}",
			".mcx_row{display:flex;flex-direction:column;gap:10px;border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:14px 16px}",
			".mcx_rowHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".mcx_name{font-weight:600;font-size:14px}",
			".mcx_url{color:var(--dsw-alias-label-secondary,#888);font-size:12px;word-break:break-all}",
			".mcx_badge{font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4)}",
			".mcx_badge.connected{color:#2e7d32;border-color:#2e7d32}",
			".mcx_badge.connecting{color:#888}",
			".mcx_badge.error{color:#c62828;border-color:#c62828}",
			".mcx_badge.disabled,.mcx_badge.stopped{color:#888}",
			".mcx_actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}",
			".mcx_btn{cursor:pointer;font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit}",
			".mcx_btn:hover{background:rgba(128,128,128,.12)}",
			".mcx_btn:disabled{opacity:.5;cursor:default}",
			".mcx_btn.primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-active,#2563eb);color:#fff}",
			".mcx_btn.danger{border-color:#c62828;color:#c62828}",
			".mcx_err{color:#c62828;font-size:12px}",
			".mcx_ok{color:#2e7d32;font-size:12px}",
			".mcx_form{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
			".mcx_form label{display:flex;flex-direction:column;gap:4px;font-size:12px}",
			".mcx_form input,.mcx_form select,.mcx_form textarea{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit}",
			".mcx_form textarea{resize:vertical;min-height:48px}",
			".mcx_form .wide{grid-column:1 / -1}",
			".mcx_add{border-style:dashed}",
			".mcx_import{border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
			".mcx_cand{display:flex;align-items:center;gap:10px;font-size:13px;padding:6px 0;border-bottom:1px dashed rgba(128,128,128,.25)}",
			".mcx_cand input{accent-color:var(--dsw-alias-interactive-bg-active,#2563eb)}",
			".mcx_candName{font-weight:600}",
			".mcx_candMeta{font-size:11px;color:var(--dsw-alias-label-secondary,#888)}",
		].join("");
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-mcp-console/section"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mcp-console";
			tag.dataset.pluginCss = "dsh-mcp-console/section";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ---- helpers ----
		const STATUS_LABEL = {
			connected: "已连接",
			connecting: "连接中",
			error: "错误",
			stopped: "未连接",
			disabled: "已禁用",
		};

		function api(path, options) {
			return fetch("/mcp-console/api" + path, {
				headers: { "Content-Type": "application/json" },
				...options,
			}).then(async (resp) => ({ ok: resp.ok, status: resp.status, body: await resp.json().catch(() => ({})) }));
		}

		function transportLabel(s) {
			if (s.transport === "stdio") {
				const c = s.config || {};
				return `stdio · ${c.command || ""} ${(c.args || []).join(" ")}`;
			}
			const c = s.config || {};
			return `HTTP · ${c.url || ""}`;
		}

		// ---- server row ----
		function ServerRow({ server, onChanged, onEdit }) {
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const connect = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/connect`, { method: "POST" });
					if (!r.ok) setError(r.body.error || "连接失败");
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const disconnect = async () => {
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}/disconnect`, { method: "POST" });
					if (!r.ok) setError(r.body.error || "断开失败");
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};
			const remove = async () => {
				if (!window.confirm(`确定删除 MCP 服务器 "${server.name}"？`)) return;
				setBusy(true); setError("");
				try {
					const r = await api(`/servers/${server.id}`, { method: "DELETE" });
					if (!r.ok) setError(r.body.error || "删除失败");
					onChanged();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			return createElement("div", { className: "mcx_row", key: server.id },
				createElement("div", { className: "mcx_rowHead" },
					createElement("span", { className: "mcx_name" }, server.name),
					createElement("span", { className: `mcx_badge ${server.status}` }, STATUS_LABEL[server.status] || server.status),
					server.status === "connected"
						? createElement("span", { className: "mcx_meta" }, `工具前缀 ${server.toolPrefix}`)
						: null,
					createElement("span", { className: "mcx_actions" },
						server.status === "connected"
							? createElement("button", { className: "mcx_btn", onClick: disconnect, disabled: busy }, busy ? "…" : "断开")
							: createElement("button", { className: "mcx_btn", onClick: connect, disabled: busy }, busy ? "…" : "连接"),
						createElement("button", { className: "mcx_btn", onClick: () => onEdit(server), disabled: busy }, "编辑"),
						createElement("button", { className: "mcx_btn danger", onClick: remove, disabled: busy }, "删除"),
					),
				),
				createElement("div", { className: "mcx_url" }, transportLabel(server)),
				server.error ? createElement("div", { className: "mcx_err" }, server.error) : null,
				error ? createElement("div", { className: "mcx_err" }, error) : null,
			);
		}

		// ---- add / edit form ----
		function ServerForm({ initial, onDone }) {
			const [transport, setTransport] = useState(initial?.transport || "stdio");
			const [name, setName] = useState(initial?.name || "");
			const [command, setCommand] = useState(initial?.config?.command || "");
			const [args, setArgs] = useState(initial?.config?.args?.join(" ") || "");
			const [env, setEnv] = useState(initial?.config?.env ? JSON.stringify(initial.config.env) : "");
			const [cwd, setCwd] = useState(initial?.config?.cwd || "");
			const [url, setUrl] = useState(initial?.config?.url || "");
			const [headers, setHeaders] = useState(initial?.config?.headers ? JSON.stringify(initial.config.headers) : "");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");

			const submit = async () => {
				setBusy(true); setError("");
				let config;
				let parsedEnv, parsedHeaders;
				try {
					parsedEnv = env.trim() ? JSON.parse(env) : {};
					if (parsedEnv && typeof parsedEnv !== "object") throw new Error("env 必须是 JSON 对象");
				} catch (e) { setError("env 解析失败: " + e.message); setBusy(false); return; }
				try {
					parsedHeaders = headers.trim() ? JSON.parse(headers) : {};
					if (parsedHeaders && typeof parsedHeaders !== "object") throw new Error("headers 必须是 JSON 对象");
				} catch (e) { setError("headers 解析失败: " + e.message); setBusy(false); return; }
				if (transport === "stdio") {
					config = { command, args: args.trim() ? args.split(/\s+/) : [], env: parsedEnv, cwd: cwd.trim() || "" };
				} else {
					config = { url, headers: parsedHeaders };
				}
				const body = { name, transport, config };
				try {
					const r = initial
						? await api(`/servers/${initial.id}`, { method: "PUT", body: JSON.stringify(body) })
						: await api("/servers", { method: "POST", body: JSON.stringify(body) });
					if (!r.ok) { setError(r.body.error || "保存失败"); setBusy(false); return; }
					onDone();
				} catch (e) { setError(String(e)); setBusy(false); }
			};

			const valid = name.trim() && (transport === "stdio" ? command.trim() : url.trim());

			return createElement("div", { className: "mcx_row mcx_add" },
				createElement("div", { className: "mcx_form" },
					createElement("label", null, "类型",
						createElement("select", { value: transport, onChange: (e) => setTransport(e.target.value) },
							createElement("option", { value: "stdio" }, "stdio（本地进程）"),
							createElement("option", { value: "streamable-http" }, "HTTP（远程服务器）"))),
					createElement("label", null, "名称（工具前缀 mcp__名称__*）",
						createElement("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "github" })),
					transport === "stdio"
						? [
							createElement("label", { className: "wide" }, "命令 command（可执行程序）",
								createElement("input", { value: command, onChange: (e) => setCommand(e.target.value), placeholder: "npx" })),
							createElement("label", { className: "wide" }, "参数 args（空格分隔，可用引号包住含空格的参数）",
								createElement("input", { value: args, onChange: (e) => setArgs(e.target.value), placeholder: "-y @modelcontextprotocol/server-filesystem /path" })),
							createElement("label", { className: "wide" }, "环境变量 env（可选，JSON 对象）",
								createElement("textarea", { value: env, onChange: (e) => setEnv(e.target.value), placeholder: '{"API_KEY":"..."}' })),
							createElement("label", { className: "wide" }, "工作目录 cwd（可选）",
								createElement("input", { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: "C:\\path\\to\\project" })),
						]
						: [
							createElement("label", { className: "wide" }, "MCP 服务器 URL",
								createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://example.com/mcp" })),
							createElement("label", { className: "wide" }, "请求头 headers（可选，JSON 对象，如认证 token）",
								createElement("textarea", { value: headers, onChange: (e) => setHeaders(e.target.value), placeholder: '{"Authorization":"Bearer xxx"}' })),
						],
				),
				error ? createElement("div", { className: "mcx_err" }, error) : null,
				createElement("div", { className: "mcx_actions" },
					createElement("button", { className: "mcx_btn primary", onClick: submit, disabled: busy || !valid }, busy ? "…" : initial ? "保存修改" : "添加"),
					createElement("button", { className: "mcx_btn", onClick: onDone, disabled: busy }, "取消"),
				),
			);
		}

		// ---- GitHub import ----
		function ImportForm({ onImported }) {
			const [url, setUrl] = useState("");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [candidates, setCandidates] = useState(null);
			const [source, setSource] = useState("");
			const [selected, setSelected] = useState({});

			const probe = async () => {
				setBusy(true); setError(""); setCandidates(null);
				try {
					const r = await api("/import/github", { method: "POST", body: JSON.stringify({ url }) });
					if (!r.ok) { setError(r.body.error || "导入失败"); setBusy(false); return; }
					setSource(r.body.source || "");
					setCandidates(r.body.candidates || []);
					const sel = {};
					(r.body.candidates || []).forEach((c) => { sel[c.name] = true; });
					setSelected(sel);
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			const applyImport = async () => {
				setBusy(true); setError("");
				const chosen = (candidates || []).filter((c) => selected[c.name]);
				try {
					const r = await api("/import/apply", { method: "POST", body: JSON.stringify({ candidates: chosen }) });
					if (!r.ok) { setError(r.body.error || "导入失败"); setBusy(false); return; }
					setCandidates(null);
					onImported();
				} catch (e) { setError(String(e)); }
				setBusy(false);
			};

			if (!candidates) {
				return createElement("div", { className: "mcx_import" },
					createElement("div", { className: "mcx_meta" }, "从 GitHub 导入 MCP 配置（支持 .mcp.json / claude_desktop_config.json / .claude/settings.json 格式）。可填仓库 URL 或 raw 文件 URL。"),
					createElement("div", { className: "mcx_form" },
						createElement("label", { className: "wide" }, "GitHub 仓库或文件 URL",
							createElement("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://github.com/owner/repo 或 https://raw.githubusercontent.com/..." })),
					),
					error ? createElement("div", { className: "mcx_err" }, error) : null,
					createElement("div", { className: "mcx_actions" },
						createElement("button", { className: "mcx_btn primary", onClick: probe, disabled: busy || !url.trim() }, busy ? "…" : "探测并预览"),
					),
				);
			}

			return createElement("div", { className: "mcx_import" },
				createElement("div", { className: "mcx_meta" }, `发现 ${candidates.length} 个 MCP 服务器（来源：${source}）— 勾选要导入的：`),
				candidates.map((c) => createElement("label", { className: "mcx_cand", key: c.name },
					createElement("input", { type: "checkbox", checked: !!selected[c.name], onChange: (e) => setSelected({ ...selected, [c.name]: e.target.checked }) }),
					createElement("span", { className: "mcx_candName" }, c.name),
					createElement("span", { className: "mcx_candMeta" }, c.transport === "stdio"
						? `${c.config.command} ${(c.config.args || []).join(" ")}`
						: c.config.url),
				)),
				error ? createElement("div", { className: "mcx_err" }, error) : null,
				createElement("div", { className: "mcx_actions" },
					createElement("button", { className: "mcx_btn primary", onClick: applyImport, disabled: busy || !candidates.some((c) => selected[c.name]) }, busy ? "…" : "导入选中"),
					createElement("button", { className: "mcx_btn", onClick: () => { setCandidates(null); setSource(""); }, disabled: busy }, "返回"),
				),
			);
		}

		// ---- main section ----
		function McpSection() {
			const [servers, setServers] = useState([]);
			const [editing, setEditing] = useState(null);
			const [adding, setAdding] = useState(false);
			const refresh = useCallback(() => {
				api("/servers").then((r) => { if (r.ok) setServers(r.body.servers || []); }).catch(() => {});
			}, []);
			useEffect(() => {
				refresh();
				const t = setInterval(refresh, 3000);
				return () => clearInterval(t);
			}, [refresh]);

			return createElement("div", { className: "mcx_section" },
				createElement("div", null,
					createElement("p", { className: "mcx_meta" }, "管理 MCP 服务器：添加后立即通过官方 @deepseek-ai/dsh-mcp-client 桥接，工具注册为 mcp__名称__*，无需重启。"),
				),
				servers.map((s) => createElement(ServerRow, { server: s, onChanged: refresh, onEdit: setEditing, key: s.id })),
				editing
					? createElement(ServerForm, { initial: servers.find((s) => s.id === editing.id) || editing, onDone: () => { setEditing(null); refresh(); } })
					: null,
				adding
					? createElement(ServerForm, { onDone: () => { setAdding(false); refresh(); } })
					: null,
				createElement(ImportForm, { onImported: refresh }),
				!adding && !editing
					? createElement("div", { className: "mcx_actions" },
						createElement("button", { className: "mcx_btn", onClick: () => setAdding(true) }, "＋ 添加 MCP 服务器"))
					: null,
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-console",
				order: 50,
				label: "MCP",
			}, McpSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
