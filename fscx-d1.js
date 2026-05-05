export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    const corsH = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    const html = (s) => new Response(s, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...corsH, "Content-Type": "application/json" } });
    const getJSON = async () => { try { return await request.json(); } catch { return {}; } };

    // ── HTML 转义（防 XSS）──────────────────────────────────
    // 所有来自数据库或用户输入的内容，在拼入 HTML 字符串前必须经此函数处理
    const esc = (s) => String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsH });

    // ── 默认配置 ────────────────────────────────────────────
    const DEFAULT_SITE = {
      pageTitle: "学业水平评价成绩查询",
      headerTitle: "学业水平评价成绩查询系统",
      headerSub: "成绩查询服务平台 · 数据来源：教务管理系统",
      noticeText: "请如实填写个人信息，查询结果仅供参考，以纸质成绩单为准。",
      footerText: "成绩查询系统",
      tabQuery: "成绩查询",
      tabHelp: "查询说明",
      helpContent: '1. 请准确填写所有必填项，信息须与报名登记一致。\n2. 若提示"信息不匹配"，请核实填写内容是否有误。\n3. 成绩以纸质通知单为准，本系统仅供参考。\n4. 如有疑问请联系所在学校教务处。'
    };
    const DEFAULT_FIELDS = [
      { id: "f_name",   label: "姓名",    placeholder: "请输入姓名",    required: true,  isUid: false, isVerify: true  },
      { id: "f_examId", label: "准考证号", placeholder: "请输入准考证号", required: true,  isUid: true,  isVerify: false },
      { id: "f_school", label: "学校",    placeholder: "请输入学校全称", required: true,  isUid: false, isVerify: true  }
    ];
    const DEFAULT_DIRECTIONS = [
      { id: "history",    label: "历史方向", subjects: ["语文","数学","英语","政治","历史","地理"] },
      { id: "physics",    label: "物理方向", subjects: ["语文","数学","英语","物理","化学","生物"] },
      { id: "vocational", label: "职业高中", subjects: ["语文","数学","英语","信息技术"] }
    ];

    // ── UID 格式校验 ────────────────────────────────────────
    const isValidUid = (uid) => uid && /^[^:\s/\\'"]{1,64}$/.test(uid);

    // ── D1 配置读写辅助 ──────────────────────────────────────
    // env.DB 现在是 D1 数据库；env.KV 仍用于 rate limit（支持 TTL 自动过期）
    const db = {
      async getConfig(key, def = null) {
        const row = await env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
        if (!row) return def;
        try { return JSON.parse(row.value); } catch { return def; }
      },
      async setConfig(key, val) {
        await env.DB.prepare(
          "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(key, JSON.stringify(val)).run();
      }
    };

    // ── IP 获取 ─────────────────────────────────────────────
    const getClientIp = () =>
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";

    // ── 暴力破解防护（KV 存储，支持 TTL 自动过期）──────────
    // [修复 H3] KV 操作全部加 try/catch，异常时拒绝请求而非静默放行
    const RATE_KEY = (ip) => `ratelimit:${ip}`;
    const MAX_FAIL = 10;
    const LOCK_TTL = 15 * 60; // 秒

    const checkRateLimit = async () => {
      const ip = getClientIp();
      let rec = { count: 0, lockedUntil: 0 };
      try {
        const raw = await env.KV.get(RATE_KEY(ip));
        if (raw) rec = JSON.parse(raw);
      } catch {
        // [H3] KV 不可用时拒绝请求，避免 rate-limit 失效
        return { blocked: true, message: "服务暂时不可用，请稍后再试", kvError: true };
      }
      const now = Date.now();
      if (rec.lockedUntil && now < rec.lockedUntil) {
        const remainMin = Math.ceil((rec.lockedUntil - now) / 60000);
        return { blocked: true, message: `操作频率过高，请 ${remainMin} 分钟后再试` };
      }
      return { blocked: false, rec, ip };
    };

    const recordFailedLogin = async (ip, rec) => {
      try {
        const count = (rec.count || 0) + 1;
        const lockedUntil = count >= MAX_FAIL ? Date.now() + LOCK_TTL * 1000 : rec.lockedUntil || 0;
        await env.KV.put(RATE_KEY(ip), JSON.stringify({ count, lockedUntil }), { expirationTtl: LOCK_TTL });
      } catch { /* KV 写入失败不影响拒绝响应 */ }
    };

    const clearRateLimit = async (ip) => {
      try { await env.KV.delete(RATE_KEY(ip)); } catch { /* 忽略 */ }
    };

    // ── [修复 H1] Token 认证 ─────────────────────────────────
    // 登录后签发随机 token 存入 KV（TTL 8h），后续请求凭 token 验证
    // 密码不再在每个管理 API 请求中传输
    const TOKEN_TTL  = 8 * 60 * 60; // 8 小时（秒）
    const TOKEN_PFX  = "admtok:";

    const issueToken = async (ttl = TOKEN_TTL) => {
      const token = crypto.randomUUID() + crypto.randomUUID(); // 72 位随机 hex
      try {
        await env.KV.put(TOKEN_PFX + token, "1", { expirationTtl: ttl });
      } catch {
        return null;
      }
      return token;
    };

    const verifyToken = async (token) => {
      if (!token || typeof token !== "string" || token.length < 60) return false;
      try {
        const val = await env.KV.get(TOKEN_PFX + token);
        return val === "1";
      } catch {
        return false;
      }
    };

    const revokeToken = async (token) => {
      try { await env.KV.delete(TOKEN_PFX + token); } catch { /* 忽略 */ }
    };

    // 从请求中取 token（优先 Authorization header，兼容 body.token）
    const getToken = (body) => {
      const authH = request.headers.get("Authorization") || "";
      if (authH.startsWith("Bearer ")) return authH.slice(7);
      return body?.token || null;
    };

    const getSite       = () => db.getConfig("site", DEFAULT_SITE);
    const getFields     = () => db.getConfig("fields", DEFAULT_FIELDS);
    const getDirections = () => db.getConfig("directions", DEFAULT_DIRECTIONS);
    const getExams      = () => db.getConfig("exams", []);

    // ══════════════════════════════════════════════════════════
    //  公开 API（前台用，无需密码）
    // ══════════════════════════════════════════════════════════
    if (url.pathname === "/api/pub/config") {
      const [site, fields, directions, exams] = await Promise.all([getSite(), getFields(), getDirections(), getExams()]);
      return json({ success: true, site, fields, directions, exams: exams.filter(e => e.open) });
    }

    if (url.pathname === "/api/pub/query" && method === "POST") {
      // [修复 H2] 公开查询接口加速率限制，防止枚举准考证号批量拉取成绩
      const rlPub = await checkRateLimit();
      if (rlPub.blocked) return json({ success: false, message: rlPub.message }, 429);

      const body = await getJSON();
      const { examId: examSessionId, uid, verifyMap } = body;
      if (!examSessionId || !uid) return json({ success: false, message: "参数不完整" });
      if (!isValidUid(uid)) return json({ success: false, message: "准考证号格式不正确" });

      // 用 D1 直接查当次成绩（单条 SQL，无需 list）
      const cur = await env.DB.prepare(
        "SELECT fields, direction, scores FROM scores WHERE exam_id = ? AND uid = ?"
      ).bind(examSessionId, uid).first();
      if (!cur) return json({ success: false, message: "未查询到成绩，请核实所填信息是否正确" });

      const curRecord = {
        fields:    JSON.parse(cur.fields    || "{}"),
        direction: cur.direction,
        scores:    JSON.parse(cur.scores    || "{}")
      };

      // 校验 verify 字段
      const fields = await getFields();
      for (const f of fields.filter(f => f.isVerify)) {
        if (curRecord.fields[f.id] !== verifyMap[f.id])
          return json({ success: false, message: `信息不匹配（${f.label}）` });
      }

      // 查历史成绩——用 D1 直接按 uid 查，O(1) 而不是全表扫描
      const histRows = await env.DB.prepare(
        "SELECT exam_id, fields, direction, scores FROM scores WHERE uid = ?"
      ).bind(uid).all();

      const exams = await getExams();
      const history = histRows.results.map(r => ({
        examSessionId: r.exam_id,
        fields:    JSON.parse(r.fields    || "{}"),
        direction: r.direction,
        scores:    JSON.parse(r.scores    || "{}")
      })).sort((a, b) => {
        const ea = exams.find(e => e.id === a.examSessionId);
        const eb = exams.find(e => e.id === b.examSessionId);
        return (ea?.date || "").localeCompare(eb?.date || "");
      });

      return json({ success: true, current: { examSessionId, ...curRecord }, history, exams });
    }

    // ══════════════════════════════════════════════════════════
    //  管理 API（需 token）
    // ══════════════════════════════════════════════════════════

    // [修复 H1] 登录：验证密码 → 签发 token，后续请求只需携带 token
    if (url.pathname === "/api/admin/login" && method === "POST") {
      const body = await getJSON();
      const rl = await checkRateLimit();
      if (rl.blocked) return json({ success: false, message: rl.message }, 429);
      if (body?.password === env.ADMIN_PASSWORD) {
        await clearRateLimit(rl.ip);
        // remember=true 时签发 7 天 token，否则 8 小时
        const ttl = body?.remember ? 7 * 24 * 60 * 60 : TOKEN_TTL;
        const token = await issueToken(ttl);
        if (!token) return json({ success: false, message: "服务暂时不可用" }, 503);
        return json({ success: true, token, expiresIn: ttl });
      } else {
        await recordFailedLogin(rl.ip, rl.rec);
        return json({ success: false, message: "密码错误" }, 401);
      }
    }

    // [修复 H1] 登出：撤销 token
    if (url.pathname === "/api/admin/logout" && method === "POST") {
      const body = await getJSON();
      await revokeToken(getToken(body));
      return json({ success: true });
    }

    // [修复 H1] 所有后续管理 API 改为 token 验证（不再传密码）
    const authByToken = async (body) => verifyToken(getToken(body));

    // 通用配置读写
    if (url.pathname === "/api/admin/config" && method === "POST") {
      const body = await getJSON();
      if (!await authByToken(body)) return json({ success: false, message: "未登录或会话已过期" }, 401);
      if (body.action === "get") {
        const [site, fields, directions, exams] = await Promise.all([getSite(), getFields(), getDirections(), getExams()]);
        return json({ success: true, site, fields, directions, exams });
      }
      if (body.action === "set") {
        const tasks = [];
        if (body.site)       tasks.push(db.setConfig("site",       body.site));
        if (body.fields)     tasks.push(db.setConfig("fields",     body.fields));
        if (body.directions) tasks.push(db.setConfig("directions", body.directions));
        if (body.exams)      tasks.push(db.setConfig("exams",      body.exams));
        await Promise.all(tasks);
        return json({ success: true });
      }
    }

    // 成绩 CRUD
    if (url.pathname === "/api/admin/score" && method === "POST") {
      const body = await getJSON();
      if (!await authByToken(body)) return json({ success: false, message: "未登录或会话已过期" }, 401);

      if (body.action === "list") {
        const { examSessionId } = body;
        let rows;
        if (examSessionId) {
          // 按批次筛选——单次 SQL 查询，替代原来的 list + N 次 get
          rows = await env.DB.prepare(
            "SELECT exam_id, uid, fields, direction, scores FROM scores WHERE exam_id = ?"
          ).bind(examSessionId).all();
        } else {
          rows = await env.DB.prepare(
            "SELECT exam_id, uid, fields, direction, scores FROM scores"
          ).all();
        }
        const list = rows.results.map(r => ({
          _key:          `score:${r.exam_id}:${r.uid}`,
          examSessionId: r.exam_id,
          uid:           r.uid,
          fields:        JSON.parse(r.fields    || "{}"),
          direction:     r.direction,
          scores:        JSON.parse(r.scores    || "{}")
        }));
        return json({ success: true, data: list });
      }

      if (body.action === "upsert") {
        const { examSessionId, uid, fields, direction, scores } = body;
        if (!examSessionId || !uid) return json({ success: false, message: "缺少批次或唯一标识" });
        if (!isValidUid(uid)) return json({ success: false, message: "唯一标识格式不合法（不能含冒号、空格等特殊字符，长度 1-64）" });
        await env.DB.prepare(
          `INSERT INTO scores (exam_id, uid, fields, direction, scores)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(exam_id, uid) DO UPDATE SET
             fields    = excluded.fields,
             direction = excluded.direction,
             scores    = excluded.scores`
        ).bind(
          examSessionId,
          uid,
          JSON.stringify(fields || {}),
          direction || "",
          JSON.stringify(scores || {})
        ).run();
        return json({ success: true });
      }

      if (body.action === "delete") {
        const { examSessionId, uid } = body;
        // [修复 M1] 同时校验 examSessionId，防止漏传时误删其他批次记录
        if (!examSessionId) return json({ success: false, message: "缺少批次 ID" });
        if (!isValidUid(uid)) return json({ success: false, message: "uid 格式不合法" });
        await env.DB.prepare(
          "DELETE FROM scores WHERE exam_id = ? AND uid = ?"
        ).bind(examSessionId, uid).run();
        return json({ success: true });
      }

      if (body.action === "deleteExam") {
        if (!body.confirm) return json({ success: false, message: "请传入 confirm:true 以确认删除整个批次" });
        // 单条 SQL 批量删除，替代原来的 list + N 次 delete
        await env.DB.prepare(
          "DELETE FROM scores WHERE exam_id = ?"
        ).bind(body.examSessionId).run();
        return json({ success: true });
      }
    }

    // ══════════════════════════════════════════════════════════
    //  页面路由
    // ══════════════════════════════════════════════════════════

    // 前台公共 CSS/结构片段
    const frontCSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--blue:#0a3d7c;--blue2:#1565c0;--blue3:#e8f0fe;--red:#c62828;--gold:#b8960c;--border:#d0d7e6;--text:#1a1a2e;--sub:#4a5568}
body{font-family:"Noto Serif SC","SimSun","宋体",serif;background:#f4f6fb;color:var(--text);min-height:100vh;display:flex;flex-direction:column}
.top-bar{height:4px;background:linear-gradient(90deg,var(--blue) 0%,var(--blue2) 60%,var(--gold) 100%)}
.header{background:var(--blue);color:#fff;padding:0 24px}
.header-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;gap:20px;padding:18px 0}
.header-emblem{width:52px;height:52px;border:2px solid rgba(255,255,255,.5);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.header-text h1{font-size:21px;font-weight:700;letter-spacing:2px;line-height:1.3}
.header-text p{font-size:12px;opacity:.7;margin-top:3px;letter-spacing:1px}
.nav{background:#1251a3;border-bottom:2px solid var(--gold)}
.nav-inner{max-width:960px;margin:0 auto;display:flex}
.nav a{display:block;padding:10px 20px;color:rgba(255,255,255,.8);font-size:13px;text-decoration:none;letter-spacing:.5px;border-right:1px solid rgba(255,255,255,.1);transition:all .2s}
.nav a:hover,.nav a.active{color:#fff;background:rgba(255,255,255,.12)}
.breadcrumb{max-width:960px;margin:12px auto;font-size:12px;color:var(--sub);display:flex;align-items:center;gap:6px;padding:0 16px}
.breadcrumb span{color:#ccc}
main{flex:1;max-width:960px;margin:0 auto;padding:0 16px 40px;width:100%}
footer{background:var(--blue);color:rgba(255,255,255,.55);text-align:center;font-size:12px;padding:16px;margin-top:auto}
footer a{color:rgba(255,255,255,.3);text-decoration:none;margin-left:14px}
footer a:hover{color:rgba(255,255,255,.7)}
.notice{background:#fff;border:1px solid var(--border);border-left:4px solid var(--blue2);padding:12px 16px;margin-bottom:18px;font-size:13px;color:var(--sub);display:flex;align-items:flex-start;gap:10px}
.notice-tag{background:var(--blue2);color:#fff;font-size:11px;padding:2px 8px;border-radius:2px;white-space:nowrap;flex-shrink:0;margin-top:1px}
.card{background:#fff;border:1px solid var(--border);border-top:3px solid var(--blue);margin-bottom:16px}
.card-title{background:var(--blue3);border-bottom:1px solid var(--border);padding:11px 20px;font-size:14px;font-weight:700;color:var(--blue);display:flex;align-items:center;gap:8px}
.card-title::before{content:"";width:3px;height:15px;background:var(--blue);display:block}
.card-body{padding:24px 32px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:16px}
.fg label{display:block;font-size:12px;color:var(--sub);margin-bottom:5px;font-weight:600;letter-spacing:.5px}
.fg label .req{color:var(--red);margin-left:2px}
.fg input,.fg select{width:100%;padding:10px 13px;border:1px solid var(--border);font-size:14px;font-family:inherit;color:var(--text);outline:none;background:#fafbff;transition:border .2s}
.fg input:focus,.fg select:focus{border-color:var(--blue2);background:#fff;box-shadow:0 0 0 3px rgba(21,101,192,.08)}
.btn-main{display:block;width:100%;padding:13px;background:var(--blue);color:#fff;border:none;font-size:15px;font-family:inherit;font-weight:700;letter-spacing:3px;cursor:pointer;transition:background .2s;margin-top:4px}
.btn-main:hover{background:var(--blue2)}
.err{color:var(--red);font-size:13px;margin-top:8px;text-align:center;min-height:18px}
`;

    // ─── GET /  前台首页 ─────────────────────────────────────
    if (method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>加载中…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>${frontCSS}
.full-select{grid-column:1/-1}
</style></head><body>
<div class="top-bar"></div>
<div class="header"><div class="header-inner">
  <div class="header-emblem">📋</div>
  <div class="header-text"><h1 id="hTitle">…</h1><p id="hSub">…</p></div>
</div></div>
<div class="nav"><div class="nav-inner">
  <a href="/" class="active" id="navQuery">成绩查询</a>
  <a href="/help" id="navHelp">查询说明</a>
</div></div>
<div class="breadcrumb">首页<span>›</span><span id="bcQuery">成绩查询</span></div>
<main>
  <div class="notice"><span class="notice-tag">通知</span><span id="noticeText">…</span></div>
  <div class="card">
    <div class="card-title" id="cardTitle">成绩查询</div>
    <div class="card-body">
      <div class="form-grid" id="fieldArea"></div>
      <button class="btn-main" onclick="go()">查　询</button>
      <div id="err" class="err"></div>
    </div>
  </div>
</main>
<footer><span id="footerText">…</span><a href="/admin">管理入口</a></footer>
<script>
let _fields=[], _uidField=null;
(async()=>{
  const r = await fetch("/api/pub/config");
  const d = await r.json();
  const {site,fields,exams} = d;
  document.title = site.pageTitle||"成绩查询";
  document.getElementById("hTitle").textContent = site.headerTitle||"";
  document.getElementById("hSub").textContent   = site.headerSub||"";
  document.getElementById("noticeText").textContent = site.noticeText||"";
  document.getElementById("footerText").textContent = site.footerText||"";
  document.getElementById("navQuery").textContent   = site.tabQuery||"成绩查询";
  document.getElementById("navHelp").textContent    = site.tabHelp||"查询说明";
  document.getElementById("bcQuery").textContent    = site.tabQuery||"成绩查询";
  _fields = fields;
  _uidField = fields.find(f=>f.isUid);

  const grid = document.getElementById("fieldArea");
  const examEl = document.createElement("div");
  examEl.className = "fg full-select";
  examEl.innerHTML = \`<label>考试批次<span class="req">*</span></label>
    <select id="f_exam">
      <option value="">-- 请选择考试批次 --</option>
      \${exams.map(e=>\`<option value="\${e.id}">\${e.label}</option>\`).join("")}
    </select>\`;
  grid.appendChild(examEl);

  fields.forEach(f=>{
    const div = document.createElement("div");
    div.className = "fg";
    div.innerHTML = \`<label>\${f.label}\${f.required?'<span class="req">*</span>':''}</label>
      <input id="\${f.id}" placeholder="\${f.placeholder||''}">\`;
    grid.appendChild(div);
  });
})();
function go(){
  const examSession = document.getElementById("f_exam").value;
  const err = document.getElementById("err");
  if(!examSession){err.textContent="请选择考试批次";return;}
  const vals={};
  for(const f of _fields){
    const v=document.getElementById(f.id)?.value.trim()||"";
    if(f.required&&!v){err.textContent=\`请填写【\${f.label}】\`;return;}
    vals[f.id]=v;
  }
  err.textContent="";
  const uid = _uidField ? vals[_uidField.id] : Object.values(vals)[0];
  location.href="/result?"+new URLSearchParams({examSession, uid, data:JSON.stringify(vals)});
}
document.addEventListener("keydown",e=>{if(e.key==="Enter")go();});
</script></body></html>`);
    }

    // ─── GET /result  结果页 ─────────────────────────────────
    if (method === "GET" && url.pathname === "/result") {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>成绩查询结果</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>${frontCSS}
.spinner{width:36px;height:36px;border:3px solid var(--blue3);border-top-color:var(--blue2);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 14px}
@keyframes spin{to{transform:rotate(360deg)}}
.loading{padding:60px 20px;text-align:center;color:var(--sub);font-size:14px;letter-spacing:1px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border);margin-bottom:20px}
.info-cell{padding:10px 15px;font-size:13px;border-bottom:1px solid var(--border);border-right:1px solid var(--border);display:flex;gap:8px}
.info-cell:nth-child(2n){border-right:none}
.info-cell:nth-last-child(-n+2){border-bottom:none}
.info-cell .lbl{color:var(--sub);font-size:12px;white-space:nowrap;width:72px;flex-shrink:0}
.info-cell .val{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
thead tr{background:var(--blue)}
thead th{color:#fff;padding:10px 15px;text-align:center;font-weight:600;letter-spacing:1px}
tbody tr:nth-child(even){background:#f8faff}
tbody tr:hover{background:var(--blue3)}
tbody td{padding:9px 15px;text-align:center;border-bottom:1px solid #eaeff8}
.total-row{background:#fff5f5!important}
.total-row td{font-weight:700;color:var(--red);font-size:15px;border-top:2px solid #ffcdd2;border-bottom:2px solid #ffcdd2}
.hist-tabs{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:16px;flex-wrap:wrap}
.hist-tab{padding:8px 18px;font-size:13px;cursor:pointer;color:var(--sub);border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s;white-space:nowrap}
.hist-tab.active{color:var(--blue2);border-bottom-color:var(--blue2);font-weight:600}
.hist-tab:hover{color:var(--blue2)}
.hist-panel{display:none}
.hist-panel.active{display:block}
.back-bar{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:14px}
.btn-back{display:inline-block;padding:9px 22px;background:var(--blue);color:#fff;font-size:13px;text-decoration:none;letter-spacing:1px;font-family:inherit}
.btn-back:hover{background:var(--blue2)}
.tip{font-size:12px;color:#aaa}
.err-box{padding:40px 20px;text-align:center}
.err-box .ico{font-size:40px;margin-bottom:12px}
.err-box .etxt{color:var(--red);font-size:15px;font-weight:600;margin-bottom:6px}
.err-box .esub{color:var(--sub);font-size:13px}
</style></head><body>
<div class="top-bar"></div>
<div class="header"><div class="header-inner">
  <div class="header-emblem">📋</div>
  <div class="header-text"><h1 id="hTitle">成绩查询结果</h1><p id="hSub"></p></div>
</div></div>
<div class="nav"><div class="nav-inner"><a href="/" id="navQuery">成绩查询</a></div></div>
<div class="breadcrumb">首页<span>›</span><span id="bcQuery">成绩查询</span><span>›</span>查询结果</div>
<main>
  <div id="loading" class="card"><div class="card-body loading"><div class="spinner"></div>正在查询，请稍候……</div></div>
  <div id="result" style="display:none">
    <div class="card">
      <div class="card-title" id="curExamTitle">当次成绩</div>
      <div class="card-body">
        <div class="info-grid" id="infoGrid"></div>
        <table><thead><tr><th>科　目</th><th>成　绩</th><th>等　次</th></tr></thead><tbody id="scoreBody"></tbody></table>
        <div class="back-bar">
          <a href="/" class="btn-back">返回查询</a>
          <span class="tip">如需留存请使用浏览器打印（Ctrl+P）</span>
        </div>
      </div>
    </div>
    <div id="histCard" class="card" style="display:none">
      <div class="card-title">历次考试成绩</div>
      <div class="card-body">
        <div class="hist-tabs" id="histTabs"></div>
        <div id="histPanels"></div>
      </div>
    </div>
  </div>
  <div id="errBox" class="card" style="display:none">
    <div class="card-body err-box">
      <div class="ico">⚠️</div>
      <div class="etxt" id="errMsg">未查询到成绩</div>
      <div class="esub">请检查所填信息是否与报名信息一致</div>
      <br><a href="/" class="btn-back" style="display:inline-block">重新查询</a>
    </div>
  </div>
</main>
<footer><span id="footerText"></span></footer>
<script>
const p = new URLSearchParams(location.search);
const examSession = p.get("examSession");
const uid         = p.get("uid");
const data        = JSON.parse(p.get("data")||"{}");

function showErr(msg){
  document.getElementById("loading").style.display="none";
  document.getElementById("errBox").style.display="block";
  document.getElementById("errMsg").textContent=msg;
}
// [修复 S3] 所有来自数据库的内容在拼入 innerHTML 前必须转义
const esc=(t)=>String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function grade(n){ return n>=120?"优秀":n>=90?"良好":n>=60?"合格":"待提升"; }
function buildTable(scores){
  let total=0,rows="";
  for(const [sub,sc] of Object.entries(scores)){
    const n=Number(sc); total+=n;
    rows+=\`<tr><td>\${esc(sub)}</td><td><strong>\${n}</strong></td><td>\${grade(n)}</td></tr>\`;
  }
  return {rows, total};
}

(async()=>{
  try{
    const cr=await fetch("/api/pub/config");
    const cd=await cr.json();
    document.title=cd.site.pageTitle||"成绩查询";
    document.getElementById("hTitle").textContent=cd.site.headerTitle||"成绩查询结果";
    document.getElementById("hSub").textContent=cd.site.headerSub||"";
    document.getElementById("footerText").textContent=cd.site.footerText||"";
    document.getElementById("navQuery").textContent=cd.site.tabQuery||"成绩查询";
    document.getElementById("bcQuery").textContent=cd.site.tabQuery||"成绩查询";
  }catch{}

  if(!examSession||!uid){ showErr("查询参数不完整，请返回重新输入"); return; }

  const cfgR = await fetch("/api/pub/config");
  const cfg  = await cfgR.json();
  const verifyMap={};
  cfg.fields.filter(f=>f.isVerify).forEach(f=>{ verifyMap[f.id]=data[f.id]||""; });

  await new Promise(r=>setTimeout(r,600));

  let res;
  try{
    const r=await fetch("/api/pub/query",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({examId:examSession,uid,verifyMap})});
    res=await r.json();
  }catch{ showErr("网络错误，请稍后重试"); return; }

  if(!res.success){ showErr(res.message||"未查询到成绩"); return; }

  document.getElementById("loading").style.display="none";
  document.getElementById("result").style.display="block";

  const cur = res.current;
  const exams = res.exams||[];

  const curExam = exams.find(e=>e.id===examSession);
  document.getElementById("curExamTitle").textContent =
    (curExam?.label||examSession) + " · 成绩单";

  const dir = cfg.directions?.find(d=>d.id===cur.direction);
  // [修复 S3] cur.fields 来自数据库，必须转义后才能拼入 innerHTML
  const infoItems = cfg.fields.map(f=>
    \`<div class="info-cell"><span class="lbl">\${esc(f.label)}</span><span class="val">\${esc(cur.fields[f.id])||"—"}</span></div>\`
  );
  infoItems.push(\`<div class="info-cell"><span class="lbl">考试方向</span><span class="val">\${esc(dir?.label||cur.direction||"—")}</span></div>\`);
  infoItems.push(\`<div class="info-cell"><span class="lbl">查询时间</span><span class="val">\${new Date().toLocaleDateString("zh-CN")}</span></div>\`);
  document.getElementById("infoGrid").innerHTML=infoItems.join("");

  const {rows,total}=buildTable(cur.scores||{});
  document.getElementById("scoreBody").innerHTML=rows+
    \`<tr class="total-row"><td>总　分</td><td>\${total}</td><td>—</td></tr>\`;

  const hist = (res.history||[]).filter(h=>h.examSessionId!==examSession);
  if(hist.length>0){
    document.getElementById("histCard").style.display="block";
    let tabs="", panels="";
    hist.forEach((h,i)=>{
      const ex=exams.find(e=>e.id===h.examSessionId);
      const lbl=ex?.label||h.examSessionId;
      const {rows:hr,total:ht}=buildTable(h.scores||{});
      tabs+=\`<div class="hist-tab\${i===0?" active":""}" onclick="switchTab(\${i})">\${lbl}</div>\`;
      panels+=\`<div class="hist-panel\${i===0?" active":""}" id="hp\${i}">
        <table><thead><tr><th>科　目</th><th>成　绩</th><th>等　次</th></tr></thead>
        <tbody>\${hr}<tr class="total-row"><td>总　分</td><td>\${ht}</td><td>—</td></tr></tbody>
        </table></div>\`;
    });
    document.getElementById("histTabs").innerHTML=tabs;
    document.getElementById("histPanels").innerHTML=panels;
  }
})();
function switchTab(i){
  document.querySelectorAll(".hist-tab").forEach((t,j)=>t.classList.toggle("active",i===j));
  document.querySelectorAll(".hist-panel").forEach((p,j)=>p.classList.toggle("active",i===j));
}
</script></body></html>`);
    }

    // ─── GET /help ───────────────────────────────────────────
    if (method === "GET" && url.pathname === "/help") {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>查询说明</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap" rel="stylesheet">
<style>${frontCSS}</style></head><body>
<div class="top-bar"></div>
<div class="header"><div class="header-inner">
  <div class="header-emblem">📋</div>
  <div class="header-text"><h1 id="hTitle">查询说明</h1><p id="hSub"></p></div>
</div></div>
<div class="nav"><div class="nav-inner">
  <a href="/" id="navQuery">成绩查询</a>
  <a href="/help" class="active" id="navHelp">查询说明</a>
</div></div>
<div class="breadcrumb">首页<span>›</span><span id="navHelp2">查询说明</span></div>
<main>
  <div class="card">
    <div class="card-title" id="helpTitle">查询说明</div>
    <div class="card-body" style="line-height:2.2;font-size:14px;color:var(--sub)">
      <div id="helpContent"></div>
    </div>
  </div>
</main>
<footer><span id="footerText"></span></footer>
<script>
(async()=>{
  const r=await fetch("/api/pub/config");
  const d=await r.json();
  const s=d.site;
  document.title=s.pageTitle||"查询说明";
  document.getElementById("hTitle").textContent=s.headerTitle||"";
  document.getElementById("hSub").textContent=s.headerSub||"";
  document.getElementById("footerText").textContent=s.footerText||"";
  document.getElementById("navQuery").textContent=s.tabQuery||"成绩查询";
  document.getElementById("navHelp").textContent=s.tabHelp||"查询说明";
  document.getElementById("navHelp2").textContent=s.tabHelp||"查询说明";
  document.getElementById("helpTitle").textContent=s.tabHelp||"查询说明";
  // [修复 S2] helpContent 来自数据库，拼入 innerHTML 前必须转义，防止 XSS
  const _esc=(t)=>String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  document.getElementById("helpContent").innerHTML=
    (s.helpContent||"").split("\\n").map((l,i)=>\`<p>\${i+1}. \${_esc(l)}</p>\`).join("");
})();
</script></body></html>`);
    }

    // ─── GET /admin  后台 ────────────────────────────────────
    if (method === "GET" && url.pathname === "/admin") {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>后台管理</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f0f2f5;--sb:#0d2447;--sb2:#162d52;--ac:#1890ff;--ac2:#096dd9;--red:#ff4d4f;--green:#52c41a;--gold:#faad14;--bd:#e8ecf3;--tx:#1c2438;--sub:#6b7280}
body{font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}
#loginPage{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0d2447,#1251a3 50%,#0d2447)}
.lc{background:#fff;width:360px;border-radius:4px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.lh{background:#0d2447;padding:28px 32px;text-align:center}
.lh h1{color:#fff;font-size:18px;letter-spacing:2px;margin-bottom:4px}
.lh p{color:rgba(255,255,255,.5);font-size:12px}
.lb{padding:28px 32px}
.lb label{display:block;font-size:12px;color:var(--sub);margin-bottom:5px;font-weight:600}
.lb input{width:100%;padding:10px 13px;border:1px solid var(--bd);border-radius:2px;font-size:14px;outline:none;font-family:inherit;transition:border .2s}
.lb input:focus{border-color:var(--ac)}
.btn-login{width:100%;margin-top:18px;padding:11px;background:var(--ac);color:#fff;border:none;font-size:14px;font-family:inherit;font-weight:600;letter-spacing:2px;cursor:pointer;border-radius:2px;transition:background .2s}
.btn-login:hover{background:var(--ac2)}
.lerr{color:var(--red);font-size:13px;margin-top:8px;text-align:center;min-height:18px}
#app{display:none;min-height:100vh;flex-direction:column}
.topnav{background:#0d2447;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.topnav .logo{font-size:15px;font-weight:700;letter-spacing:1px;display:flex;align-items:center;gap:10px}
.logo-ico{background:var(--ac);width:28px;height:28px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:14px}
.topnav .usr{font-size:13px;color:rgba(255,255,255,.65);cursor:pointer}
.topnav .usr:hover{color:#fff}
.layout{display:flex;flex:1;height:calc(100vh - 52px)}
.sb{width:210px;background:var(--sb);flex-shrink:0;overflow-y:auto}
.sb-sec{padding:16px 12px 6px;font-size:11px;color:rgba(255,255,255,.3);letter-spacing:1px;font-weight:600}
.sb a{display:flex;align-items:center;gap:10px;padding:10px 16px;color:rgba(255,255,255,.65);font-size:13px;text-decoration:none;cursor:pointer;transition:all .15s;border-left:3px solid transparent;user-select:none}
.sb a:hover{background:var(--sb2);color:#fff}
.sb a.active{background:rgba(24,144,255,.15);color:var(--ac);border-left-color:var(--ac)}
.sb a .ico{width:18px;text-align:center;font-size:15px}
.content{flex:1;overflow-y:auto;padding:20px 24px}
.tab{display:none}.tab.active{display:block}
.card{background:#fff;border-radius:4px;border:1px solid var(--bd);margin-bottom:16px}
.ch{padding:13px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between}
.ch h3{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
.ch h3::before{content:"";width:3px;height:14px;background:var(--ac);display:block;border-radius:2px}
.cb{padding:20px}
.fg{display:flex;flex-direction:column;gap:5px}
.fg label{font-size:12px;color:var(--sub);font-weight:600}
.fg input,.fg select,.fg textarea{padding:8px 12px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none;transition:border .2s;background:#fff;width:100%}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--ac)}
.fg textarea{resize:vertical;min-height:80px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 16px;border:none;border-radius:2px;font-size:13px;font-family:inherit;cursor:pointer;font-weight:500;transition:all .2s}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover{background:var(--ac2)}
.btn-d{background:var(--red);color:#fff}.btn-d:hover{background:#cf1322}
.btn-g{background:#fff;color:var(--tx);border:1px solid var(--bd)}.btn-g:hover{border-color:var(--ac);color:var(--ac)}
.btn-s{background:var(--green);color:#fff}
.sm{padding:4px 12px;font-size:12px}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
thead tr{background:#f5f7fa}
thead th{padding:9px 13px;text-align:left;font-weight:600;color:var(--sub);font-size:12px;border-bottom:1px solid var(--bd)}
tbody tr{border-bottom:1px solid #f0f0f0;transition:background .15s}
tbody tr:hover{background:#f0f7ff}
tbody td{padding:9px 13px}
.badge{display:inline-block;padding:2px 8px;border-radius:2px;font-size:11px;font-weight:600}
.b0{background:#e6f7ff;color:var(--ac)}.b1{background:#f9f0ff;color:#722ed1}
.b2{background:#e6fffb;color:#08979c}.b3{background:#fff7e6;color:#d46b08}
.msg{padding:7px 13px;border-radius:2px;font-size:12px;margin-top:8px;display:none}
.msg.ok{background:#f6ffed;border:1px solid #b7eb8f;color:#389e0d;display:block}
.msg.er{background:#fff2f0;border:1px solid #ffccc7;color:var(--red);display:block}
.field-row{background:#fff;border:1px solid var(--bd);border-radius:4px;padding:12px 14px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr 1fr auto auto auto auto;gap:10px;align-items:center}
.field-row input{padding:6px 10px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none;width:100%}
.field-row input:focus{border-color:var(--ac)}
.ck{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;font-size:11px;color:var(--sub);cursor:pointer}
.ck input{width:auto;cursor:pointer}
.drag-handle{cursor:grab;color:#ccc;font-size:18px;user-select:none;padding:0 4px}
.drag-handle:active{cursor:grabbing}
.stags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.stag{background:#f0f7ff;border:1px solid #bae0ff;color:var(--ac);padding:3px 10px;border-radius:2px;font-size:12px;display:flex;align-items:center;gap:4px}
.stag .x{cursor:pointer;color:var(--sub);font-size:10px;font-weight:700}.stag .x:hover{color:var(--red)}
.addrow{display:flex;gap:8px}
.addrow input{flex:1;padding:6px 10px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none}
.addrow input:focus{border-color:var(--ac)}
.stat3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}
.scard{background:#fff;border:1px solid var(--bd);border-radius:4px;padding:18px;display:flex;align-items:center;gap:14px}
.sico{width:42px;height:42px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px}
.sico.bl{background:#e6f7ff}.sico.gr{background:#f6ffed}.sico.go{background:#fffbe6}
.snum{font-size:26px;font-weight:700;line-height:1}.slbl{font-size:12px;color:var(--sub);margin-top:3px}
.exam-row{background:#fff;border:1px solid var(--bd);border-radius:4px;padding:12px 14px;margin-bottom:8px;display:flex;align-items:center;gap:12px}
.exam-row .er-info{flex:1;display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:center}
.exam-row .er-info input{padding:6px 10px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none}
.exam-row .er-info input:focus{border-color:var(--ac)}
.open-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--sub);white-space:nowrap}
</style></head><body>

<div id="loginPage">
  <div class="lc">
    <div class="lh"><h1>后台管理系统</h1><p>成绩查询平台 · 管理员专用</p></div>
    <div class="lb">
      <label>管理员密码</label>
      <input id="pwd" type="password" placeholder="请输入密码" onkeydown="if(event.key==='Enter')login()">
      <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--sub);cursor:pointer;font-weight:400">
        <input type="checkbox" id="rememberMe" style="width:auto"> 记住登录状态（7天）
      </label>
      <button class="btn-login" onclick="login()">登　录</button>
      <div id="lerr" class="lerr"></div>
    </div>
  </div>
</div>

<div id="app">
  <div class="topnav">
    <div class="logo"><span class="logo-ico">📋</span>成绩管理后台</div>
    <div class="usr" onclick="logout()">🔓 退出登录</div>
  </div>
  <div class="layout">
    <div class="sb">
      <div class="sb-sec">成绩管理</div>
      <a onclick="go('scores')" class="active"><span class="ico">📋</span>成绩查看</a>
      <a onclick="go('add')"><span class="ico">➕</span>录入成绩</a>
      <a onclick="go('import')"><span class="ico">📥</span>批量导入</a>
      <div class="sb-sec">系统配置</div>
      <a onclick="go('exams')"><span class="ico">🗂</span>考试批次</a>
      <a onclick="go('fields')"><span class="ico">🔧</span>查询字段</a>
      <a onclick="go('directions')"><span class="ico">📚</span>方向科目</a>
      <a onclick="go('site')"><span class="ico">🎨</span>页面设置</a>
      <div class="sb-sec">统计</div>
      <a onclick="go('stats')"><span class="ico">📊</span>统计概览</a>
    </div>
    <div class="content">

      <!-- ══ 成绩查看 ══ -->
      <div id="tab-scores" class="tab active">
        <div class="card">
          <div class="ch"><h3>筛选</h3></div>
          <div class="cb">
            <div class="g3" style="margin-bottom:10px">
              <div class="fg"><label>考试批次</label><select id="sc_exam"><option value="">全部批次</option></select></div>
              <div id="sc_dynFields" class="fg" style="display:contents"></div>
            </div>
            <button class="btn btn-p" onclick="loadScores()">🔍 搜索</button>
          </div>
        </div>
        <div class="card">
          <div class="ch"><h3>成绩列表</h3><div style="display:flex;align-items:center;gap:10px">
            <span id="sc_count" style="font-size:12px;color:var(--sub)"></span>
            <select id="sc_pageSize" onchange="sc_page=1;filterScores()" style="padding:4px 8px;border:1px solid var(--bd);border-radius:2px;font-size:12px;font-family:inherit;outline:none">
              <option value="20">每页 20</option>
              <option value="50" selected>每页 50</option>
              <option value="100">每页 100</option>
              <option value="200">每页 200</option>
              <option value="0">全部显示</option>
            </select>
            <button class="btn btn-d sm" id="batchDelBtn" style="display:none" onclick="batchDelete()">🗑 删除所选</button>
          </div></div>
          <div class="cb" style="padding:0">
            <div class="tw"><table>
              <thead><tr id="sc_thead"></tr></thead>
              <tbody id="sc_body"></tbody>
            </table></div>
            <div id="sc_pagination" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 16px;border-top:1px solid var(--bd);flex-wrap:wrap"></div>
          </div>
        </div>
        <div id="editArea"></div>
      </div>

      <!-- ══ 录入成绩 ══ -->
      <div id="tab-add" class="tab">
        <div class="card">
          <div class="ch"><h3>录入学生成绩</h3></div>
          <div class="cb">
            <div class="g3" style="margin-bottom:14px">
              <div class="fg"><label>考试批次 *</label><select id="a_exam" onchange="renderAddSubj()"><option value="">请选择</option></select></div>
              <div class="fg"><label>考试方向 *</label><select id="a_dir" onchange="renderAddSubj()"><option value="">请选择</option></select></div>
            </div>
            <div class="g3" id="a_dynFields" style="margin-bottom:14px"></div>
            <div style="padding-top:14px;border-top:1px solid var(--bd)">
              <div style="font-size:12px;color:var(--sub);margin-bottom:8px;font-weight:600">各科成绩</div>
              <div class="g4" id="a_subj"></div>
            </div>
            <div style="margin-top:14px;display:flex;gap:10px">
              <button class="btn btn-p" onclick="addScore()">✅ 提交</button>
              <button class="btn btn-g" onclick="clearAdd()">↺ 清空</button>
            </div>
            <div id="addMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 批量导入 ══ -->
      <div id="tab-import" class="tab">
        <div class="card">
          <div class="ch"><h3>📥 批量导入成绩</h3></div>
          <div class="cb">
            <div class="g2" style="margin-bottom:16px">
              <div class="fg">
                <label>目标考试批次 *</label>
                <select id="im_exam"><option value="">请选择批次</option></select>
              </div>
            </div>
            <div id="im_dropzone" style="border:2px dashed var(--bd);border-radius:6px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .2s;background:#fafbff;margin-bottom:16px"
              onclick="q('im_file').click()"
              ondragover="event.preventDefault();this.style.borderColor='var(--ac)';this.style.background='#e6f7ff'"
              ondragleave="this.style.borderColor='var(--bd)';this.style.background='#fafbff'"
              ondrop="event.preventDefault();this.style.borderColor='var(--bd)';this.style.background='#fafbff';handleImportFile(event.dataTransfer.files[0])">
              <div style="font-size:32px;margin-bottom:8px">📂</div>
              <div style="font-size:14px;font-weight:600;color:var(--tx);margin-bottom:4px">点击选择文件，或将文件拖拽到此处</div>
              <div style="font-size:12px;color:var(--sub)">支持 Excel（.xlsx/.xls）、CSV（.csv）、文本（.txt）</div>
              <input id="im_file" type="file" accept=".xlsx,.xls,.csv,.txt" style="display:none" onchange="handleImportFile(this.files[0])">
            </div>
            <div id="im_parsing" style="display:none;text-align:center;padding:20px;color:var(--sub);font-size:13px">
              <div style="font-size:24px;margin-bottom:8px">⏳</div>正在解析文件…
            </div>
            <div id="im_mapArea" style="display:none">
              <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--tx)">📋 列映射确认</div>
              <div style="font-size:12px;color:var(--sub);margin-bottom:10px;line-height:1.8;background:#fffbe6;border:1px solid #ffe58f;padding:8px 12px;border-radius:4px">
                系统已自动识别列映射，<strong style="color:#d46b08">橙色</strong>为需手动确认的列，<strong style="color:var(--red)">红色</strong>为识别失败的列。请检查后点击「预览数据」。
              </div>
              <div id="im_mapTable" style="overflow-x:auto;margin-bottom:12px"></div>
              <button class="btn btn-p" onclick="renderImportPreview()">👁 预览数据</button>
            </div>
            <div id="im_previewArea" style="display:none">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                <div style="font-size:13px;font-weight:600;color:var(--tx)">📊 数据预览</div>
                <div id="im_summary" style="font-size:12px;color:var(--sub)"></div>
              </div>
              <div id="im_previewTable" style="overflow-x:auto;max-height:360px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--bd);border-radius:4px"></div>
              <div style="display:flex;gap:10px;align-items:center">
                <button class="btn btn-p" onclick="doImport()">✅ 确认导入</button>
                <button class="btn btn-g" onclick="resetImport()">↺ 重新选择</button>
              </div>
            </div>
            <div id="im_progressArea" style="display:none">
              <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--tx)">⏫ 导入中…</div>
              <div style="background:#f0f0f0;border-radius:4px;height:10px;overflow:hidden;margin-bottom:8px">
                <div id="im_bar" style="background:var(--ac);height:100%;width:0%;transition:width .3s;border-radius:4px"></div>
              </div>
              <div id="im_prog_txt" style="font-size:12px;color:var(--sub)">0 / 0</div>
            </div>
            <div id="im_resultArea" style="display:none">
              <div id="im_resultBox"></div>
              <div style="margin-top:12px">
                <button class="btn btn-g" onclick="resetImport()">↺ 继续导入</button>
              </div>
            </div>
            <div id="importMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 考试批次 ══ -->
      <div id="tab-exams" class="tab">
        <div class="card">
          <div class="ch"><h3>考试批次管理</h3><button class="btn btn-p sm" onclick="addExamRow()">＋ 新增批次</button></div>
          <div class="cb">
            <div style="font-size:12px;color:var(--sub);margin-bottom:10px">
              <strong>字段说明：</strong>批次ID（英文唯一）· 显示名称 · 考试日期 · 是否对前台开放查询
            </div>
            <div id="examList"></div>
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="btn btn-p" onclick="saveExams()">💾 保存所有批次</button>
            </div>
            <div id="examMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 查询字段配置 ══ -->
      <div id="tab-fields" class="tab">
        <div class="card">
          <div class="ch"><h3>查询字段配置</h3><button class="btn btn-p sm" onclick="addFieldRow()">＋ 新增字段</button></div>
          <div class="cb">
            <div style="font-size:12px;color:var(--sub);margin-bottom:10px;line-height:1.8">
              <strong>唯一键</strong>：用于跨批次串联同一学生的历史记录（只能有一个）<br>
              <strong>校验字段</strong>：查询时与数据库比对，不一致则拒绝（姓名、学校等）<br>
              <strong>字段顺序</strong>可拖拽调整
            </div>
            <div id="fieldList"></div>
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="btn btn-p" onclick="saveFields()">💾 保存字段配置</button>
            </div>
            <div id="fieldMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 方向科目 ══ -->
      <div id="tab-directions" class="tab">
        <div class="card">
          <div class="ch"><h3>方向与科目管理</h3><button class="btn btn-p sm" onclick="showAddDir()">＋ 新增方向</button></div>
          <div class="cb">
            <div id="addDirForm" style="display:none;background:#f8faff;border:1px solid var(--bd);padding:14px;border-radius:4px;margin-bottom:14px">
              <div class="g2" style="margin-bottom:10px">
                <div class="fg"><label>方向名称（如：历史方向）</label><input id="nd_label" placeholder="对外显示名称"></div>
                <div class="fg"><label>方向ID（英文唯一标识）</label><input id="nd_id" placeholder="如 history"></div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-p sm" onclick="addDir()">确认</button>
                <button class="btn btn-g sm" onclick="showAddDir()">取消</button>
              </div>
            </div>
            <div id="dirList"></div>
            <div id="dirMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 页面设置 ══ -->
      <div id="tab-site" class="tab">
        <div class="card">
          <div class="ch"><h3>页面文字设置</h3></div>
          <div class="cb">
            <div class="g2" style="margin-bottom:12px">
              <div class="fg"><label>浏览器标签页标题</label><input id="s_pageTitle"></div>
              <div class="fg"><label>页眉大标题</label><input id="s_headerTitle"></div>
              <div class="fg"><label>页眉副标题</label><input id="s_headerSub"></div>
              <div class="fg"><label>页脚文字</label><input id="s_footerText"></div>
              <div class="fg"><label>导航栏"查询"标签名</label><input id="s_tabQuery"></div>
              <div class="fg"><label>导航栏"说明"标签名</label><input id="s_tabHelp"></div>
            </div>
            <div class="fg" style="margin-bottom:12px">
              <label>顶部公告通知文字</label>
              <textarea id="s_noticeText"></textarea>
            </div>
            <div class="fg" style="margin-bottom:12px">
              <label>查询说明页内容（每行一条，自动加序号）</label>
              <textarea id="s_helpContent" style="min-height:120px"></textarea>
            </div>
            <button class="btn btn-p" onclick="saveSite()">💾 保存设置</button>
            <div id="siteMsg" class="msg"></div>
          </div>
        </div>
      </div>

      <!-- ══ 统计 ══ -->
      <div id="tab-stats" class="tab">
        <div class="stat3">
          <div class="scard"><div class="sico bl">👥</div><div><div class="snum" id="st_stu">—</div><div class="slbl">学生总数（去重）</div></div></div>
          <div class="scard"><div class="sico gr">📝</div><div><div class="snum" id="st_rec">—</div><div class="slbl">成绩记录总数</div></div></div>
          <div class="scard"><div class="sico go">🗂</div><div><div class="snum" id="st_exam">—</div><div class="slbl">考试批次数</div></div></div>
        </div>
        <div class="card">
          <div class="ch"><h3>各批次录入情况</h3></div>
          <div class="cb"><div id="st_detail" style="font-size:13px;color:var(--sub)">加载中…</div></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
let pwd="", cfg={site:{},fields:[],directions:[],exams:[]}, allScores=[];
// [修复 H1] 改用 token 认证，密码仅在登录时使用一次
// token 优先从 localStorage（记住登录）读取，其次 sessionStorage
let _token = localStorage.getItem("adm_token") || sessionStorage.getItem("adm_token") || "";
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 分钟无操作自动登出
let _idleTimer = null;
const resetIdle = () => {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => { alert("会话已超时，请重新登录"); logout(); }, IDLE_TIMEOUT);
};
document.addEventListener("click", resetIdle);
document.addEventListener("keydown", resetIdle);

const api = async(path,body)=>{
  // [修复 H1] 所有管理请求携带 token，不再传密码
  const payload = _token ? { ...body, token: _token } : body;
  const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  if(r.status===401){ logout(); return {success:false,message:"会话已过期"}; }
  return r.json();
};

// 页面加载时若已有 token，自动登录
(async()=>{
  if(_token){
    const r=await api("/api/admin/config",{action:"get"});
    if(r.success){
      q("loginPage").style.display="none";
      const app=q("app"); app.style.display="flex"; app.style.flexDirection="column";
      cfg.site=r.site||{}; cfg.fields=r.fields||[]; cfg.directions=r.directions||[]; cfg.exams=r.exams||[];
      refreshExamDropdowns(); renderSiteForm(); await loadScores();
      resetIdle();
    } else {
      // token 已过期，清掉
      localStorage.removeItem("adm_token"); sessionStorage.removeItem("adm_token"); _token="";
    }
  }
})();
const showMsg=(id,txt,type)=>{
  const el=document.getElementById(id);
  el.textContent=txt; el.className="msg "+type;
  setTimeout(()=>el.style.display="none",3000);
};
const q=id=>document.getElementById(id);
const make=(tag,props={},inner="")=>{
  const el=document.createElement(tag);
  Object.assign(el,props); el.innerHTML=inner; return el;
};

async function login(){
  const p=q("pwd").value.trim();
  const remember=q("rememberMe")?.checked||false;
  // 记住登录时请求 7 天有效期的 token
  const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p,remember})});
  const d=await r.json();
  if(!d.success){q("lerr").textContent=d.message;return;}
  // [修复 H1] 存 token，丢弃密码
  _token=d.token;
  if(remember){
    localStorage.setItem("adm_token", _token);   // 7天，关闭浏览器也保留
  } else {
    sessionStorage.setItem("adm_token", _token);  // 关闭标签页即清除
  }
  q("loginPage").style.display="none";
  const app=q("app"); app.style.display="flex"; app.style.flexDirection="column";
  resetIdle();
  await loadAll();
}
async function logout(){
  if(_token) await fetch("/api/admin/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:_token})}).catch(()=>{});
  _token=""; pwd="";
  localStorage.removeItem("adm_token");
  sessionStorage.removeItem("adm_token");
  clearTimeout(_idleTimer);
  q("loginPage").style.display="flex";q("app").style.display="none";
}

async function loadAll(){
  const r=await api("/api/admin/config",{action:"get"});
  if(!r.success)return;
  cfg.site=r.site||{}; cfg.fields=r.fields||[]; cfg.directions=r.directions||[]; cfg.exams=r.exams||[];
  refreshExamDropdowns();
  renderSiteForm();
  await loadScores();
}

function go(tab){
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  document.querySelectorAll(".sb a").forEach(a=>a.classList.remove("active"));
  q("tab-"+tab).classList.add("active");
  const tabs=["scores","add","import","exams","fields","directions","site","stats"];
  document.querySelectorAll(".sb a")[tabs.indexOf(tab)]?.classList.add("active");
  if(tab==="exams")    renderExamList();
  if(tab==="fields")   renderFieldList();
  if(tab==="directions") renderDirList();
  if(tab==="site")     renderSiteForm();
  if(tab==="stats")    renderStats();
  if(tab==="add")      {renderAddDyn(); renderAddSubj();}
}

function refreshExamDropdowns(){
  const opts='<option value="">全部批次</option>'+cfg.exams.map(e=>\`<option value="\${e.id}">\${e.label}</option>\`).join("");
  const addOpts=cfg.exams.map(e=>\`<option value="\${e.id}">\${e.label}</option>\`).join("");
  if(q("sc_exam")) q("sc_exam").innerHTML=opts;
  if(q("a_exam"))  q("a_exam").innerHTML='<option value="">请选择</option>'+addOpts;
  if(q("im_exam")) q("im_exam").innerHTML='<option value="">请选择批次</option>'+addOpts;
  const dirOpts=cfg.directions.map(d=>\`<option value="\${d.id}">\${d.label}</option>\`).join("");
  if(q("a_dir")) q("a_dir").innerHTML='<option value="">请选择</option>'+dirOpts;
  const sc=q("sc_dynFields");
  if(sc){
    sc.innerHTML="";
    cfg.fields.forEach(f=>{
      const div=make("div",{className:"fg"},\`<label>\${f.label}</label><input id="scf_\${f.id}" placeholder="模糊搜索">\`);
      sc.appendChild(div);
    });
  }
}

async function loadScores(){
  const examId=q("sc_exam").value;
  const r=await api("/api/admin/score",{action:"list",examSessionId:examId||undefined});
  if(!r.success)return;
  allScores=r.data;
  sc_page=1;
  filterScores();
}
let sc_page=1, sc_filtered=[];
function filterScores(){
  sc_filtered=[...allScores];
  cfg.fields.forEach(f=>{
    const v=q("scf_"+f.id)?.value.trim();
    if(v) sc_filtered=sc_filtered.filter(x=>x.fields?.[f.id]?.includes(v));
  });

  const pageSize=parseInt(q("sc_pageSize")?.value||"50");
  const total=sc_filtered.length;
  const totalPages=pageSize>0?Math.max(1,Math.ceil(total/pageSize)):1;
  if(sc_page>totalPages) sc_page=totalPages;

  const list=pageSize>0?sc_filtered.slice((sc_page-1)*pageSize,sc_page*pageSize):sc_filtered;

  q("sc_count").textContent=\`共 \${total} 条\${pageSize>0?\`，第 \${sc_page}/\${totalPages} 页\`:""}\`;

  const thead=q("sc_thead");
  thead.innerHTML=\`<th style="width:36px"><input type="checkbox" id="chkAll" onchange="toggleAll(this.checked)" title="全选"></th>\`
    +"<th>考试批次</th>"+cfg.fields.map(f=>\`<th>\${f.label}</th>\`).join("")+"<th>方向</th><th>操作</th>";

  const tbody=q("sc_body");
  tbody.innerHTML="";
  list.forEach(item=>{
    const exam=cfg.exams.find(e=>e.id===item.examSessionId);
    const dir=cfg.directions.find(d=>d.id===item.direction);
    const di=cfg.directions.findIndex(d=>d.id===item.direction);
    const key=\`\${item.examSessionId}||||\${item.uid}\`;
    const tr=document.createElement("tr");
    tr.innerHTML=\`<td><input type="checkbox" class="row-chk" data-key="\${key}" onchange="updateBatchBtn()"></td>\`
      +\`<td><span class="badge b\${cfg.exams.findIndex(e=>e.id===item.examSessionId)%4}">\${exam?.label||item.examSessionId}</span></td>\`
      +cfg.fields.map(f=>\`<td>\${item.fields?.[f.id]||"—"}</td>\`).join("")
      +\`<td><span class="badge b\${di%4}">\${dir?.label||item.direction||"—"}</span></td>
      <td style="display:flex;gap:6px">
        <button class="btn btn-g sm" onclick='editScore(\`+JSON.stringify(item)+\`)'>编辑</button>
        <button class="btn btn-d sm" onclick="delScore('\${item.examSessionId}','\${item.uid}')">删除</button>
      </td>\`;
    tbody.appendChild(tr);
  });
  updateBatchBtn();

  // 渲染分页控件
  const pg=q("sc_pagination");
  if(!pg) return;
  if(pageSize===0||totalPages<=1){pg.innerHTML="";return;}
  let btns="";
  btns+=\`<button class="btn btn-g sm" \${sc_page===1?"disabled":""} onclick="goPage(1)">«</button>\`;
  btns+=\`<button class="btn btn-g sm" \${sc_page===1?"disabled":""} onclick="goPage(\${sc_page-1})">‹</button>\`;
  // 显示页码窗口
  const w=2;
  for(let i=1;i<=totalPages;i++){
    if(i===1||i===totalPages||Math.abs(i-sc_page)<=w){
      btns+=\`<button class="btn sm \${i===sc_page?"btn-p":"btn-g"}" onclick="goPage(\${i})">\${i}</button>\`;
    } else if(Math.abs(i-sc_page)===w+1){
      btns+=\`<span style="padding:0 4px;color:var(--sub)">…</span>\`;
    }
  }
  btns+=\`<button class="btn btn-g sm" \${sc_page===totalPages?"disabled":""} onclick="goPage(\${sc_page+1})">›</button>\`;
  btns+=\`<button class="btn btn-g sm" \${sc_page===totalPages?"disabled":""} onclick="goPage(\${totalPages})">»</button>\`;
  btns+=\`<span style="font-size:12px;color:var(--sub);margin-left:6px">跳转</span>\`;
  btns+=\`<input type="number" id="pageJump" min="1" max="\${totalPages}" value="\${sc_page}" style="width:50px;padding:4px 6px;border:1px solid var(--bd);border-radius:2px;font-size:12px;font-family:inherit;outline:none;text-align:center" onkeydown="if(event.key==='Enter')goPage(parseInt(this.value))">\`;
  pg.innerHTML=btns;
}
function goPage(p){
  const pageSize=parseInt(q("sc_pageSize")?.value||"50");
  const totalPages=pageSize>0?Math.max(1,Math.ceil(sc_filtered.length/pageSize)):1;
  sc_page=Math.max(1,Math.min(p,totalPages));
  filterScores();
  q("sc_body")?.closest(".card")?.scrollIntoView({behavior:"smooth",block:"start"});
}
function toggleAll(checked){
  document.querySelectorAll(".row-chk").forEach(c=>c.checked=checked);
  updateBatchBtn();
}
function updateBatchBtn(){
  const sel=document.querySelectorAll(".row-chk:checked").length;
  const btn=q("batchDelBtn");
  if(btn){ btn.style.display=sel>0?"inline-flex":"none"; btn.textContent=\`🗑 删除所选（\${sel}）\`; }
  const all=document.querySelectorAll(".row-chk").length;
  const chkAll=q("chkAll"); if(chkAll) chkAll.indeterminate=sel>0&&sel<all, chkAll.checked=sel===all&&all>0;
}
async function batchDelete(){
  const keys=[...document.querySelectorAll(".row-chk:checked")].map(c=>c.dataset.key);
  if(!keys.length) return;
  if(!confirm(\`确认删除选中的 \${keys.length} 条记录？此操作不可撤销。\`)) return;
  let ok=0,fail=0;
  await Promise.all(keys.map(async key=>{
    const [examSessionId,uid]=key.split("||||");
    const r=await api("/api/admin/score",{action:"delete",examSessionId,uid});
    r.success?ok++:fail++;
  }));
  alert(\`删除完成：成功 \${ok} 条\${fail?\`，失败 \${fail} 条\`:""}\`);
  await loadScores();
}
async function delScore(examSessionId,uid){
  if(!confirm("确认删除？")) return;
  await api("/api/admin/score",{action:"delete",examSessionId,uid});
  await loadScores();
}
function editScore(item){
  const box=q("editArea");
  const dirOpts=cfg.directions.map(d=>\`<option value="\${d.id}" \${item.direction===d.id?"selected":""}>\${d.label}</option>\`).join("");
  const fieldInputs=cfg.fields.map(f=>
    \`<div class="fg"><label>\${f.label}</label><input id="ef_\${f.id}" value="\${item.fields?.[f.id]||""}"></div>\`
  ).join("");
  const uidField=cfg.fields.find(f=>f.isUid);
  const uid=uidField?item.fields?.[uidField.id]:item.uid;
  const dir=cfg.directions.find(d=>d.id===item.direction);
  const subjInputs=(dir?.subjects||[]).map(s=>
    \`<div class="fg"><label>\${s}</label><input class="es" data-s="\${s}" value="\${item.scores?.[s]??0}" type="number" min="0" max="200"></div>\`
  ).join("");
  box.innerHTML=\`<div class="card">
    <div class="ch"><h3>编辑成绩记录</h3><button class="btn btn-g sm" onclick="q('editArea').innerHTML=''">✕ 关闭</button></div>
    <div class="cb">
      <div class="g3" style="margin-bottom:12px">\${fieldInputs}
        <div class="fg"><label>考试方向</label><select id="e_dir" onchange="reloadEditSubj('\${item.examSessionId}','\${uid}')">\${dirOpts}</select></div>
      </div>
      <div style="padding-top:12px;border-top:1px solid var(--bd)">
        <div style="font-size:12px;color:var(--sub);margin-bottom:8px;font-weight:600">各科成绩</div>
        <div class="g4" id="e_subj">\${subjInputs}</div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn btn-p" onclick="saveEdit('\${item.examSessionId}','\${uid}')">💾 保存</button>
      </div>
      <div id="editMsg" class="msg"></div>
    </div>
  </div>\`;
  box.scrollIntoView({behavior:"smooth"});
}
function reloadEditSubj(examSessionId,uid){
  const dir=cfg.directions.find(d=>d.id===q("e_dir").value);
  const item=allScores.find(x=>x.examSessionId===examSessionId&&x.uid===uid);
  q("e_subj").innerHTML=(dir?.subjects||[]).map(s=>
    \`<div class="fg"><label>\${s}</label><input class="es" data-s="\${s}" value="\${item?.scores?.[s]??0}" type="number" min="0" max="200"></div>\`
  ).join("");
}
async function saveEdit(examSessionId,uid){
  const fields={};
  cfg.fields.forEach(f=>{fields[f.id]=q("ef_"+f.id)?.value.trim()||"";});
  const scores={};
  document.querySelectorAll(".es").forEach(i=>{scores[i.dataset.s]=Number(i.value||0);});
  const r=await api("/api/admin/score",{action:"upsert",examSessionId,uid,fields,direction:q("e_dir").value,scores});
  showMsg("editMsg",r.success?"保存成功 ✓":r.message,r.success?"ok":"er");
  if(r.success){await loadScores();q("editArea").innerHTML="";}
}

function renderAddDyn(){
  const box=q("a_dynFields");
  box.innerHTML=cfg.fields.map(f=>
    \`<div class="fg"><label>\${f.label} *</label><input id="af_\${f.id}" placeholder="\${f.placeholder||""}"></div>\`
  ).join("");
}
function renderAddSubj(){
  const dir=cfg.directions.find(d=>d.id===q("a_dir")?.value);
  q("a_subj").innerHTML=(dir?.subjects||[]).map(s=>
    \`<div class="fg"><label>\${s}</label><input class="as" data-s="\${s}" value="0" type="number" min="0" max="200"></div>\`
  ).join("");
}
async function addScore(){
  const examId=q("a_exam").value;
  const dirId=q("a_dir").value;
  if(!examId||!dirId){showMsg("addMsg","请选择考试批次和方向","er");return;}
  const fields={};
  for(const f of cfg.fields){
    const v=q("af_"+f.id)?.value.trim()||"";
    if(f.required&&!v){showMsg("addMsg",\`请填写【\${f.label}】\`,"er");return;}
    fields[f.id]=v;
  }
  const uidField=cfg.fields.find(f=>f.isUid);
  const uid=uidField?fields[uidField.id]:Object.values(fields)[0];
  if(!uid){showMsg("addMsg","唯一键字段为空","er");return;}
  const scores={};
  document.querySelectorAll(".as").forEach(i=>{scores[i.dataset.s]=Number(i.value||0);});
  const r=await api("/api/admin/score",{action:"upsert",examSessionId:examId,uid,fields,direction:dirId,scores});
  showMsg("addMsg",r.success?"录入成功 ✓":r.message,r.success?"ok":"er");
  if(r.success){clearAdd();await loadScores();}
}
function clearAdd(){
  cfg.fields.forEach(f=>{const el=q("af_"+f.id);if(el)el.value="";});
  renderAddSubj();
}

function renderExamList(){
  const box=q("examList");
  box.innerHTML=cfg.exams.map((e,i)=>\`
    <div class="exam-row">
      <div class="er-info">
        <input id="ex_id_\${i}" value="\${e.id}" placeholder="批次ID（英文）">
        <input id="ex_label_\${i}" value="\${e.label}" placeholder="显示名称（如：2025年期末）">
        <input id="ex_date_\${i}" value="\${e.date||""}" placeholder="考试日期（如：2025-06-20）" type="date">
        <label class="open-toggle">
          <input type="checkbox" id="ex_open_\${i}" \${e.open?"checked":""}> 对外开放
        </label>
      </div>
      <button class="btn btn-d sm" onclick="removeExam(\${i})">删除</button>
    </div>\`).join("")||'<p style="color:#bbb;font-size:13px">暂无批次，点击右上角新增</p>';
}
function addExamRow(){
  cfg.exams.push({id:"",label:"",date:"",open:false});
  renderExamList();
}
function removeExam(i){
  if(!confirm("删除该批次配置？（不会删除已录入成绩）"))return;
  cfg.exams.splice(i,1);
  renderExamList();
}
async function saveExams(){
  const newExams=cfg.exams.map((e,i)=>({
    id:q("ex_id_"+i)?.value.trim()||e.id,
    label:q("ex_label_"+i)?.value.trim()||e.label,
    date:q("ex_date_"+i)?.value||e.date,
    open:q("ex_open_"+i)?.checked||false
  }));
  const ids=newExams.map(e=>e.id).filter(Boolean);
  if(new Set(ids).size!==ids.length){showMsg("examMsg","批次ID有重复，请修改","er");return;}
  const r=await api("/api/admin/config",{action:"set",exams:newExams});
  if(r.success){cfg.exams=newExams;refreshExamDropdowns();}
  showMsg("examMsg",r.success?"保存成功 ✓":r.message,r.success?"ok":"er");
}

function renderFieldList(){
  const box=q("fieldList");
  box.innerHTML=cfg.fields.map((f,i)=>\`
    <div class="field-row" draggable="true" id="fr\${i}" ondragstart="dragStart(\${i})" ondragover="dragOver(event,\${i})" ondrop="drop(\${i})">
      <span class="drag-handle" title="拖拽排序">⠿</span>
      <input id="fl_id_\${i}"    value="\${f.id}"          placeholder="字段ID（英文）">
      <input id="fl_label_\${i}" value="\${f.label}"        placeholder="显示名称">
      <input id="fl_ph_\${i}"    value="\${f.placeholder||""}" placeholder="输入框提示">
      <label class="ck"><input type="checkbox" id="fl_req_\${i}"  \${f.required?"checked":""}><span>必填</span></label>
      <label class="ck" title="唯一键：跨批次串联同学生（只设一个）"><input type="checkbox" id="fl_uid_\${i}" \${f.isUid?"checked":""}><span>唯一键</span></label>
      <label class="ck" title="校验字段：查询时与库比对"><input type="checkbox" id="fl_ver_\${i}" \${f.isVerify?"checked":""}><span>校验</span></label>
      <button class="btn btn-d sm" onclick="removeField(\${i})">✕</button>
    </div>\`).join("")||'<p style="color:#bbb;font-size:13px">暂无字段</p>';
}
function addFieldRow(){
  cfg.fields.push({id:"f_new"+Date.now(),label:"新字段",placeholder:"",required:true,isUid:false,isVerify:false});
  renderFieldList();
}
function removeField(i){cfg.fields.splice(i,1);renderFieldList();}
let _dragIdx=null;
function dragStart(i){_dragIdx=i;}
function dragOver(e,i){e.preventDefault();}
function drop(i){
  if(_dragIdx===null||_dragIdx===i)return;
  const arr=[...cfg.fields];
  const [item]=arr.splice(_dragIdx,1); arr.splice(i,0,item);
  cfg.fields=arr; renderFieldList(); _dragIdx=null;
}
async function saveFields(){
  const newFields=cfg.fields.map((f,i)=>({
    id:q("fl_id_"+i)?.value.trim()||f.id,
    label:q("fl_label_"+i)?.value.trim()||f.label,
    placeholder:q("fl_ph_"+i)?.value||f.placeholder||"",
    required:!!q("fl_req_"+i)?.checked,
    isUid:!!q("fl_uid_"+i)?.checked,
    isVerify:!!q("fl_ver_"+i)?.checked
  }));
  const uids=newFields.filter(f=>f.isUid);
  if(uids.length>1){showMsg("fieldMsg","唯一键只能设置一个","er");return;}
  if(uids.length===0){showMsg("fieldMsg","请至少设置一个唯一键字段","er");return;}
  const r=await api("/api/admin/config",{action:"set",fields:newFields});
  if(r.success){cfg.fields=newFields;refreshExamDropdowns();}
  showMsg("fieldMsg",r.success?"保存成功 ✓":r.message,r.success?"ok":"er");
}

function renderDirList(){
  q("dirList").innerHTML=cfg.directions.map((d,i)=>\`
    <div class="card" style="margin-bottom:10px">
      <div class="ch">
        <h3>\${d.label} <span style="font-size:11px;color:var(--sub);font-family:monospace;font-weight:400;background:#f5f5f5;padding:1px 6px;border-radius:2px">\${d.id}</span></h3>
        <button class="btn btn-d sm" onclick="delDir('\${d.id}')">删除方向</button>
      </div>
      <div class="cb">
        <div class="stags" id="stags_\${d.id}">
          \${d.subjects.map(s=>\`<span class="stag">\${s}<span class="x" onclick="delSubj('\${d.id}','\${s}')">✕</span></span>\`).join("")}
          \${!d.subjects.length?'<span style="font-size:12px;color:#bbb">暂无科目</span>':""}
        </div>
        <div class="addrow">
          <input id="ns_\${d.id}" placeholder="输入科目名，回车添加" onkeydown="if(event.key==='Enter')addSubj('\${d.id}')">
          <button class="btn btn-p sm" onclick="addSubj('\${d.id}')">＋ 添加</button>
        </div>
      </div>
    </div>\`).join("")||'<p style="color:#bbb;font-size:13px">暂无方向</p>';
}
function showAddDir(){const f=q("addDirForm");f.style.display=f.style.display==="none"?"block":"none";}
async function addDir(){
  const label=q("nd_label").value.trim(), id=q("nd_id").value.trim().replace(/\s/g,"");
  if(!label||!id){showMsg("dirMsg","请填写名称和ID","er");return;}
  if(cfg.directions.find(d=>d.id===id)){showMsg("dirMsg","ID已存在","er");return;}
  cfg.directions.push({id,label,subjects:[]});
  await saveDirections("dirMsg");
  q("nd_label").value=""; q("nd_id").value="";
  showAddDir(); renderDirList();
}
async function delDir(id){
  if(!confirm("删除该方向？"))return;
  cfg.directions=cfg.directions.filter(d=>d.id!==id);
  await saveDirections("dirMsg"); renderDirList();
}
async function addSubj(dirId){
  const input=q("ns_"+dirId), name=input.value.trim();
  if(!name)return;
  const dir=cfg.directions.find(d=>d.id===dirId);
  if(dir.subjects.includes(name)){input.value="";return;}
  dir.subjects.push(name); input.value="";
  await saveDirections("dirMsg"); renderDirList();
}
async function delSubj(dirId,sub){
  const dir=cfg.directions.find(d=>d.id===dirId);
  dir.subjects=dir.subjects.filter(s=>s!==sub);
  await saveDirections("dirMsg"); renderDirList();
}
async function saveDirections(msgId){
  const r=await api("/api/admin/config",{action:"set",directions:cfg.directions});
  if(r.success) refreshExamDropdowns();
  if(msgId) showMsg(msgId,r.success?"保存成功 ✓":r.message,r.success?"ok":"er");
}

function renderSiteForm(){
  const s=cfg.site;
  ["pageTitle","headerTitle","headerSub","footerText","tabQuery","tabHelp","noticeText","helpContent"].forEach(k=>{
    const el=q("s_"+k); if(el) el.value=s[k]||"";
  });
}
async function saveSite(){
  const site={};
  ["pageTitle","headerTitle","headerSub","footerText","tabQuery","tabHelp","noticeText","helpContent"].forEach(k=>{
    const el=q("s_"+k); if(el) site[k]=el.value.trim();
  });
  const r=await api("/api/admin/config",{action:"set",site});
  if(r.success) cfg.site=site;
  showMsg("siteMsg",r.success?"保存成功 ✓":r.message,r.success?"ok":"er");
}

async function renderStats(){
  const r=await api("/api/admin/score",{action:"list"});
  if(!r.success)return;
  const list=r.data;
  const uids=new Set(list.map(x=>x.uid));
  q("st_stu").textContent=uids.size;
  q("st_rec").textContent=list.length;
  q("st_exam").textContent=cfg.exams.length;
  const byExam={};
  cfg.exams.forEach(e=>{byExam[e.id]=0;});
  list.forEach(x=>{byExam[x.examSessionId]=(byExam[x.examSessionId]||0)+1;});
  const total=list.length||1;
  q("st_detail").innerHTML=cfg.exams.map(e=>{
    const cnt=byExam[e.id]||0, pct=Math.round(cnt/total*100);
    return \`<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span>\${e.label}</span><span style="font-weight:600">\${cnt} 条（\${pct}%）</span>
      </div>
      <div style="background:#f0f0f0;border-radius:2px;height:8px;overflow:hidden">
        <div style="background:var(--ac);width:\${pct}%;height:100%;border-radius:2px;transition:width .6s"></div>
      </div>
    </div>\`;
  }).join("")||"<p style='color:#bbb'>暂无数据</p>";
}
</script>
<script src="/admin-import.js"></script>
</body></html>`);
    }

    // ─── GET /admin-import.js  批量导入脚本 ─────────────────
    if (method === "GET" && url.pathname === "/admin-import.js") {
      const importJS = String.raw`
let im_rawRows=[], im_headers=[], im_colMap=[];

function norm(s){ return String(s||"").trim().replace(/[\s\u3000]+/g,"").toLowerCase(); }

function buildMatchRules(){
  const rules=[];
  cfg.fields.forEach(f=>{
    const aliases=[norm(f.label), norm(f.id), norm(f.placeholder||"")];
    if(f.isUid) aliases.push("准考证","考号","准考证号","examid","uid","id");
    if(norm(f.label).includes("姓名")||norm(f.id).includes("name")) aliases.push("姓名","名字","name");
    if(norm(f.label).includes("学校")||norm(f.id).includes("school")) aliases.push("学校","学校名称","school","单位");
    rules.push({ type:"field", fieldId:f.id, label:f.label, aliases:[...new Set(aliases)] });
  });
  rules.push({ type:"direction", fieldId:"__direction__", label:"方向",
    aliases:["方向","考试方向","direction","dir","类别","专业方向","track"] });
  const allSubjects=[...new Set(cfg.directions.flatMap(d=>d.subjects))];
  allSubjects.forEach(s=>{
    rules.push({ type:"subject", fieldId:"__subj__"+s, label:s, aliases:[norm(s)] });
  });
  return rules;
}

function matchColumn(header, rules){
  const h=norm(header);
  for(const r of rules){ if(r.aliases.some(a=>a===h)) return {...r, confidence:"exact"}; }
  for(const r of rules){ if(r.aliases.some(a=>h.includes(a)||a.includes(h))) return {...r, confidence:"fuzzy"}; }
  if(h) return { type:"subject", fieldId:"__subj__"+header.trim(), label:header.trim(), aliases:[h], confidence:"unknown" };
  return null;
}

function matchDirection(val){
  const v=norm(val);
  if(!v||v==="-") return null;
  for(const d of cfg.directions){ if(norm(d.id)===v||norm(d.label)===v) return d.id; }
  for(const d of cfg.directions){
    if(norm(d.label).includes(v)||v.includes(norm(d.label))) return d.id;
    if(norm(d.id).includes(v)||v.includes(norm(d.id))) return d.id;
  }
  return null;
}

async function handleImportFile(file){
  if(!file) return;
  if(!q("im_exam").value){ showMsg("importMsg","请先选择目标考试批次","er"); return; }
  q("im_parsing").style.display="block";
  ["im_mapArea","im_previewArea","im_progressArea","im_resultArea"].forEach(id=>q(id).style.display="none");
  try{
    const ext=file.name.split(".").pop().toLowerCase();
    if(ext==="xlsx"||ext==="xls"){ await parseExcel(file); }
    else { await parseTextFile(file, ext); }
  } catch(e){
    q("im_parsing").style.display="none";
    showMsg("importMsg","文件解析失败："+e.message,"er");
  }
}

async function parseExcel(file){
  if(!window.XLSX){
    await new Promise((res,rej)=>{
      const s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      s.onload=res; s.onerror=()=>rej(new Error("SheetJS加载失败，请检查网络"));
      document.head.appendChild(s);
    });
  }
  const buf=await file.arrayBuffer();
  const wb=XLSX.read(buf,{type:"array"});
  const ws=wb.Sheets[wb.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:""});
  if(!rows.length) throw new Error("表格为空");
  im_headers=rows[0].map(h=>String(h||"").trim());
  im_rawRows=rows.slice(1).filter(r=>r.some(c=>String(c||"").trim()));
  q("im_parsing").style.display="none";
  buildColMapUI();
}

async function parseTextFile(file, ext){
  const text=await file.text();
  const lines=text.split(/\r?\n/).filter(l=>l.trim());
  if(!lines.length) throw new Error("文件为空");
  const delimiters=[
    {sep:"\t", name:"制表符"},
    {sep:",", name:"逗号"},
    {sep:"|", name:"竖线"},
    {sep:";", name:"分号"},
  ];
  let best=delimiters[0], bestCount=0;
  for(const d of delimiters){
    const cnt=(lines[0].split(d.sep).length-1);
    if(cnt>bestCount){ bestCount=cnt; best=d; }
  }
  const split=bestCount>0 ? (l=>l.split(best.sep)) : (l=>l.trim().split(/\s{2,}/));
  im_headers=split(lines[0]).map(h=>h.trim());
  im_rawRows=lines.slice(1).map(l=>split(l).map(c=>c.trim())).filter(r=>r.some(c=>c));
  q("im_parsing").style.display="none";
  buildColMapUI();
}

function buildColMapUI(){
  const rules=buildMatchRules();
  im_colMap=im_headers.map(h=>({ header:h, match:matchColumn(h,rules) }));
  const allOptions=[
    "<option value='__skip__'>— 忽略此列 —</option>",
    "<optgroup label='学生信息'>",
    ...cfg.fields.map(f=>"<option value='field:"+f.id+"'>"+f.label+"</option>"),
    "</optgroup>",
    "<optgroup label='特殊'>",
    "<option value='direction:'>考试方向</option>",
    "</optgroup>",
    "<optgroup label='科目成绩'>",
    ...[...new Set(cfg.directions.flatMap(d=>d.subjects))].map(s=>"<option value='subj:"+s+"'>"+s+"</option>"),
    "<option value='subj:__custom__'>（自定义科目，用列名）</option>",
    "</optgroup>",
  ].join("");
  const rows=im_colMap.map((c,i)=>{
    const m=c.match;
    let color="var(--sub)", badge="";
    if(m){
      if(m.confidence==="exact")   { color="var(--green)"; badge="<span style='color:var(--green);font-size:11px'>✅ 自动</span>"; }
      else if(m.confidence==="fuzzy") { color="var(--gold)"; badge="<span style='color:var(--gold);font-size:11px'>⚠️ 请确认</span>"; }
      else { color="var(--red)"; badge="<span style='color:var(--red);font-size:11px'>❓ 未知列</span>"; }
    }
    return "<tr><td style='padding:7px 12px;font-weight:600;color:"+color+";white-space:nowrap'>"+c.header+"</td>"
      +"<td style='padding:7px 12px'>"+badge+"</td>"
      +"<td style='padding:7px 12px'><select id='cm_"+i+"' style='padding:5px 8px;border:1px solid var(--bd);border-radius:2px;font-size:12px;font-family:inherit;outline:none;min-width:160px'>"+allOptions+"</select></td>"
      +"<td style='padding:7px 12px;font-size:11px;color:#aaa'>示例："+(im_rawRows[0]?.[i]||"")+"</td></tr>";
  }).join("");
  q("im_mapTable").innerHTML="<table style='border-collapse:collapse;font-size:13px;width:100%'>"
    +"<thead><tr style='background:#f5f7fa'>"
    +"<th style='padding:7px 12px;text-align:left;font-size:12px;color:var(--sub);border-bottom:1px solid var(--bd)'>文件列名</th>"
    +"<th style='padding:7px 12px;text-align:left;font-size:12px;color:var(--sub);border-bottom:1px solid var(--bd)'>识别结果</th>"
    +"<th style='padding:7px 12px;text-align:left;font-size:12px;color:var(--sub);border-bottom:1px solid var(--bd)'>映射到</th>"
    +"<th style='padding:7px 12px;text-align:left;font-size:12px;color:var(--sub);border-bottom:1px solid var(--bd)'>数据示例</th>"
    +"</tr></thead><tbody>"+rows+"</tbody></table>";
  im_colMap.forEach((_,i)=>{
    const sel=q("cm_"+i);
    if(!sel) return;
    const m=im_colMap[i].match;
    let val="__skip__";
    if(m){
      if(m.type==="field") val="field:"+m.fieldId;
      else if(m.type==="direction") val="direction:";
      else val="subj:"+m.fieldId.replace("__subj__","");
      if(m.confidence==="unknown") val="subj:"+im_colMap[i].header;
    }
    sel.value=val;
  });
  q("im_mapArea").style.display="block";
}

function renderImportPreview(){
  const finalMap=im_colMap.map((_,i)=>({ header:im_colMap[i].header, mapped:q("cm_"+i)?.value||"__skip__" }));
  const parsed=im_rawRows.map((row,ri)=>{
    const fields={}, scores={};
    let direction=null, dirRaw="", warnings=[];
    finalMap.forEach((col,ci)=>{
      const val=String(row[ci]||"").trim();
      if(col.mapped==="__skip__") return;
      if(col.mapped.startsWith("field:")){
        const fid=col.mapped.replace("field:","");
        fields[fid]=val;
      } else if(col.mapped==="direction:"){
        dirRaw=val;
        direction=matchDirection(val);
        if(val&&val!=="-"&&!direction) warnings.push("方向\""+val+"\"未匹配");
      } else if(col.mapped.startsWith("subj:")){
        let subj=col.mapped.replace("subj:","");
        if(subj==="__custom__") subj=col.header;
        if(val==="-"||val==="") {}
        else { const n=Number(val); scores[subj]=isNaN(n)?null:n; if(isNaN(n)) warnings.push("\""+subj+"\"成绩\""+val+"\"非数字"); }
      }
    });
    const uidField=cfg.fields.find(f=>f.isUid);
    const uid=uidField?fields[uidField.id]:"";
    if(!uid) warnings.push("uid为空");
    return { fields, direction, dirRaw, scores, uid, warnings, rowIdx:ri+2 };
  });
  const okCount=parsed.filter(r=>!r.warnings.length).length;
  const warnCount=parsed.filter(r=>r.warnings.length&&r.uid).length;
  const errCount=parsed.filter(r=>!r.uid).length;
  q("im_summary").innerHTML="共 <strong>"+parsed.length+"</strong> 行 · <span style='color:var(--green)'>✅ "+okCount+" 正常</span> · <span style='color:var(--gold)'>⚠️ "+warnCount+" 警告</span> · <span style='color:var(--red)'>❌ "+errCount+" 错误（将跳过）</span>";
  const fieldCols=cfg.fields.map(f=>"<th style='padding:7px 10px;white-space:nowrap'>"+f.label+"</th>").join("");
  const allSubjs=[...new Set(parsed.flatMap(r=>Object.keys(r.scores)))];
  const subjCols=allSubjs.map(s=>"<th style='padding:7px 10px;white-space:nowrap'>"+s+"</th>").join("");
  const bodyRows=parsed.map(r=>{
    const bg=r.warnings.length?(r.uid?"#fffbe6":"#fff2f0"):"";
    const fieldTds=cfg.fields.map(f=>"<td style='padding:6px 10px'>"+(r.fields[f.id]||"—")+"</td>").join("");
    const subjTds=allSubjs.map(s=>{
      const v=r.scores[s];
      if(v===undefined) return "<td style='padding:6px 10px;color:#ccc'>-</td>";
      if(v===null) return "<td style='padding:6px 10px;color:var(--red)'>❌</td>";
      return "<td style='padding:6px 10px'>"+v+"</td>";
    }).join("");
    const warnTd=r.warnings.length
      ?"<td style='padding:6px 10px;color:"+(r.uid?"var(--gold)":"var(--red)")+";font-size:11px'>"+r.warnings.join("；")+"</td>"
      :"<td style='padding:6px 10px;color:var(--green);font-size:11px'>✅</td>";
    return "<tr style='background:"+bg+";border-bottom:1px solid #f0f0f0'><td style='padding:6px 10px;color:var(--sub);font-size:11px'>"+r.rowIdx+"</td>"+fieldTds+"<td style='padding:6px 10px'>"+(r.dirRaw||"—")+"</td>"+subjTds+warnTd+"</tr>";
  }).join("");
  q("im_previewTable").innerHTML="<table style='border-collapse:collapse;font-size:12px;min-width:100%'>"
    +"<thead style='background:var(--ac);color:#fff;position:sticky;top:0'><tr>"
    +"<th style='padding:7px 10px'>行</th>"+fieldCols+"<th style='padding:7px 10px'>方向</th>"+subjCols+"<th style='padding:7px 10px'>状态</th>"
    +"</tr></thead><tbody>"+bodyRows+"</tbody></table>";
  q("im_previewArea")._parsed=parsed;
  q("im_previewArea")._allSubjs=allSubjs;
  q("im_mapArea").style.display="none";
  q("im_previewArea").style.display="block";
}

async function doImport(){
  const parsed=q("im_previewArea")._parsed||[];
  const examId=q("im_exam").value;
  const toImport=parsed.filter(r=>r.uid);
  if(!toImport.length){ showMsg("importMsg","没有可导入的有效数据","er"); return; }
  q("im_previewArea").style.display="none";
  q("im_progressArea").style.display="block";
  const BATCH=20;
  let ok=0, fail=0, failList=[];
  const total=toImport.length;
  for(let i=0;i<total;i+=BATCH){
    const chunk=toImport.slice(i,i+BATCH);
    await Promise.all(chunk.map(async r=>{
      const r2=await api("/api/admin/score",{
        action:"upsert",
        examSessionId:examId, uid:r.uid,
        fields:r.fields, direction:r.direction||"", scores:r.scores
      });
      if(r2.success) ok++;
      else { fail++; failList.push("第"+r.rowIdx+"行："+r2.message); }
    }));
    const done=Math.min(i+BATCH,total);
    q("im_bar").style.width=(done/total*100)+"%";
    q("im_prog_txt").textContent=done+" / "+total;
    await new Promise(res=>setTimeout(res,30));
  }
  q("im_progressArea").style.display="none";
  q("im_resultArea").style.display="block";
  const failHtml=failList.length
    ?"<div style='margin-top:10px;background:#fff2f0;border:1px solid #ffccc7;border-radius:4px;padding:10px 14px;font-size:12px;color:var(--red);max-height:150px;overflow-y:auto'><strong>失败详情：</strong><br>"+failList.join("<br>")+"</div>":"";
  q("im_resultBox").innerHTML="<div style='background:#f6ffed;border:1px solid #b7eb8f;border-radius:4px;padding:16px 20px'>"
    +"<div style='font-size:16px;font-weight:700;color:var(--green);margin-bottom:6px'>导入完成 ✅</div>"
    +"<div style='font-size:13px;color:var(--tx)'>成功导入 <strong>"+ok+"</strong> 条，失败 <strong style='color:"+(fail?"var(--red)":"inherit")+"'>"+fail+"</strong> 条</div>"
    +"</div>"+failHtml;
  await loadScores();
}

function resetImport(){
  im_rawRows=[]; im_headers=[]; im_colMap=[];
  q("im_file").value="";
  ["im_mapArea","im_previewArea","im_progressArea","im_resultArea","im_parsing"].forEach(id=>q(id).style.display="none");
  q("im_bar").style.width="0%";
}
`;
      return new Response(importJS, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }

    return json({ success: false, message: "Not Found" }, 404);
  }
};