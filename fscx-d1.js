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

      // 教师端获取考试批次列表（不需要验证，仅返回 exams 列表）
      if (body?._getExams) {
        const exams = await db.getConfig("exams", []);
        return json({ success: true, exams });
      }

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
    //  教师账号管理 API（需管理员 token）
    // ══════════════════════════════════════════════════════════
    if (url.pathname === "/api/admin/teacher" && method === "POST") {
      const body = await getJSON();
      if (!await authByToken(body)) return json({ success: false, message: "未登录或会话已过期" }, 401);

      // 读取教师索引
      const getTchrIndex = async () => {
        try { const r = await env.KV.get("tchr:index"); return r ? JSON.parse(r) : []; } catch { return []; }
      };
      const saveTchrIndex = async (idx) => {
        try { await env.KV.put("tchr:index", JSON.stringify(idx)); } catch {}
      };

      if (body.action === "list") {
        const idx = await getTchrIndex();
        const teachers = await Promise.all(idx.map(async id => {
          try { const r = await env.KV.get("tchr:" + id); return r ? JSON.parse(r) : null; } catch { return null; }
        }));
        return json({ success: true, data: teachers.filter(Boolean) });
      }

      const hashPwd = async (pwd) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pwd));
        return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
      };

      if (body.action === "add") {
        const { id, password, type, subject, classes, name } = body;
        if (!id || !password) return json({ success: false, message: "编号和密码不能为空" });
        const existing = await env.KV.get("tchr:" + id).catch(() => null);
        if (existing) return json({ success: false, message: "该编号已存在" });
        const teacher = { id, password: await hashPwd(password), type: type || "subject", subject: subject || "", classes: classes || [], name: name || id };
        await env.KV.put("tchr:" + id, JSON.stringify(teacher));
        const idx = await getTchrIndex();
        if (!idx.includes(id)) { idx.push(id); await saveTchrIndex(idx); }
        return json({ success: true });
      }

      if (body.action === "delete") {
        const { id } = body;
        if (!id) return json({ success: false, message: "缺少编号" });
        await env.KV.delete("tchr:" + id).catch(() => {});
        // 同时撤销该教师所有 token（遍历代价高，用前缀标记）
        const idx = (await getTchrIndex()).filter(x => x !== id);
        await saveTchrIndex(idx);
        return json({ success: true });
      }

      if (body.action === "update") {
        const { id, password, type, subject, classes, name } = body;
        if (!id) return json({ success: false, message: "缺少编号" });
        const existing = await env.KV.get("tchr:" + id).catch(() => null);
        if (!existing) return json({ success: false, message: "教师不存在" });
        const old = JSON.parse(existing);
        const updated = { ...old, name: name ?? old.name, password: password ? await hashPwd(password) : old.password, type: type || old.type, subject: subject ?? old.subject, classes: classes ?? old.classes };
        await env.KV.put("tchr:" + id, JSON.stringify(updated));
        return json({ success: true });
      }

      return json({ success: false, message: "未知操作" });
    }

    // ── 教师登录 ─────────────────────────────────────────────
    if (url.pathname === "/api/teacher/login" && method === "POST") {
      const body = await getJSON();
      const rl = await checkRateLimit();
      if (rl.blocked) return json({ success: false, message: rl.message }, 429);
      const { id, password } = body;
      if (!id || !password) return json({ success: false, message: "请输入编号和密码" });
      let teacher = null;
      try { const r = await env.KV.get("tchr:" + id); teacher = r ? JSON.parse(r) : null; } catch {}
      const hashPwd = async (pwd) => {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pwd));
        return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
      };
      if (!teacher || teacher.password !== await hashPwd(password)) {
        await recordFailedLogin(rl.ip, rl.rec);
        return json({ success: false, message: "编号或密码错误" }, 401);
      }
      await clearRateLimit(rl.ip);
      // 签发教师 token（存教师ID，8h有效）
      const token = crypto.randomUUID() + crypto.randomUUID();
      try { await env.KV.put("tchtok:" + token, id, { expirationTtl: 8 * 3600 }); } catch {
        return json({ success: false, message: "服务暂时不可用" }, 503);
      }
      return json({ success: true, token, teacher: { id: teacher.id, name: teacher.name, type: teacher.type, subject: teacher.subject, classes: teacher.classes } });
    }

    // ── 教师登出 ─────────────────────────────────────────────
    if (url.pathname === "/api/teacher/logout" && method === "POST") {
      const body = await getJSON();
      const tok = body?.token;
      if (tok) await env.KV.delete("tchtok:" + tok).catch(() => {});
      return json({ success: true });
    }

    // ── 教师数据查询（班级成绩 + 统计）────────────────────────
    if (url.pathname === "/api/teacher/data" && method === "POST") {
      const body = await getJSON();
      const tok = body?.token;
      if (!tok) return json({ success: false, message: "未登录" }, 401);

      // 并行：验证 token + 读取配置
      const { examSessionId, className } = body;
      if (!examSessionId) return json({ success: false, message: "请选择考试批次" });
      if (!className)     return json({ success: false, message: "请选择班级" });

      const [teacherId, fieldsArr, directionsArr, allRows] = await Promise.all([
        env.KV.get("tchtok:" + tok).catch(() => null),
        db.getConfig("fields", DEFAULT_FIELDS),
        db.getConfig("directions", DEFAULT_DIRECTIONS),
        env.DB.prepare("SELECT uid, direction, fields, scores FROM scores WHERE exam_id = ?")
          .bind(examSessionId).all()
      ]);

      if (!teacherId) return json({ success: false, message: "会话已过期，请重新登录" }, 401);

      // 用 teacherId 查教师信息（token 验证完才有 id，无法提前并行）
      let teacher = null;
      try { const r = await env.KV.get("tchr:" + teacherId); teacher = r ? JSON.parse(r) : null; } catch {}
      if (!teacher) return json({ success: false, message: "账号不存在" }, 401);

      if (teacher.type !== "homeroom" && !teacher.classes.includes(className))
        return json({ success: false, message: "无权查看该班级" });

      // 解析成绩数据
      const allData = (allRows.results || []).map(r => ({
        uid: r.uid, direction: r.direction,
        fields: JSON.parse(r.fields || "{}"),
        scores: JSON.parse(r.scores || "{}")
      }));

      // 找班级字段ID
      const classFieldId = fieldsArr.find(f => f.label.includes("班") || f.id.includes("class"))?.id;
      if (!classFieldId) return json({ success: false, message: "未找到班级字段，请在查询字段中确认字段标签含【班】字" });

      // 过滤出该班学生
      const classData = allData.filter(s => s.fields[classFieldId] === className);
      if (!classData.length) return json({ success: false, message: "该班级暂无成绩数据" });

      // 确定可见科目
      const allSubjects = [...new Set(directionsArr.flatMap(d => d.subjects || []))];
      const visibleSubjects = teacher.type === "homeroom" ? allSubjects : [teacher.subject].filter(Boolean);

      // 年级所有班级
      const gradeClasses = [...new Set(allData.map(s => s.fields[classFieldId]).filter(Boolean))];

      // 计算年级各科平均分（按班级汇总）
      const classAvgMap = {};
      for (const cn of gradeClasses) {
        const cd = allData.filter(s => s.fields[classFieldId] === cn);
        classAvgMap[cn] = {};
        for (const subj of visibleSubjects) {
          const vals = cd.map(s => Number(s.scores[subj] || 0)).filter(v => v > 0);
          classAvgMap[cn][subj] = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
        }
      }

      // 计算总分（全科）
      const getTotalScore = (s) => allSubjects.reduce((sum, subj) => sum + Number(s.scores[subj] || 0), 0);

      // 年级 / 班级排名
      const gradeSorted = [...allData].sort((a, b) => getTotalScore(b) - getTotalScore(a));
      const gradeRankMap = {};
      gradeSorted.forEach((s, i) => { gradeRankMap[s.uid] = i + 1; });

      const classSorted = [...classData].sort((a, b) => getTotalScore(b) - getTotalScore(a));
      const classRankMap = {};
      classSorted.forEach((s, i) => { classRankMap[s.uid] = i + 1; });

      // 各科班级均分年级排名
      const subjGradeRank = {};
      for (const subj of visibleSubjects) {
        const sorted = [...gradeClasses].sort((a, b) => (classAvgMap[b]?.[subj] || 0) - (classAvgMap[a]?.[subj] || 0));
        subjGradeRank[subj] = sorted.indexOf(className) + 1;
      }

      // 本班各科平均分
      const classSubjAvg = classAvgMap[className] || {};
      const classSubjAvgTotal = visibleSubjects.length
        ? visibleSubjects.reduce((s, subj) => s + (classSubjAvg[subj] || 0), 0) / visibleSubjects.length
        : 0;

      // 组装学生数据
      const students = classData.map(s => {
        const visScores = {};
        for (const subj of visibleSubjects) visScores[subj] = s.scores[subj] || 0;
        return {
          uid: s.uid, fields: s.fields, direction: s.direction,
          scores: visScores,
          total: getTotalScore(s),
          classRank: classRankMap[s.uid],
          gradeRank: gradeRankMap[s.uid]
        };
      });

      return json({
        success: true,
        teacher: { id: teacher.id, name: teacher.name, type: teacher.type, subject: teacher.subject },
        className, totalStudents: allData.length, classCount: gradeClasses.length,
        visibleSubjects, students, classSubjAvg, subjGradeRank,
        classAvgTotal: classSubjAvgTotal
      });
    }

    // ══════════════════════════════════════════════════════════
    //  页面路由
    // ══════════════════════════════════════════════════════════

    // 前台公共 CSS/结构片段
    const frontCSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--blue:#0a3d7c;--blue2:#1565c0;--blue3:#e8f0fe;--red:#c62828;--gold:#b8960c;--border:#d0d7e6;--text:#1a1a2e;--sub:#4a5568}
body{font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","WenQuanYi Micro Hei",sans-serif;background:#f4f6fb;color:var(--text);min-height:100vh;display:flex;flex-direction:column}
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
@media(max-width:600px){
.header{padding:0 12px}
.header-inner{gap:12px;padding:12px 0}
.header-emblem{width:40px;height:40px;font-size:18px}
.header-text h1{font-size:16px;letter-spacing:1px}
.header-text p{font-size:11px}
.nav a{padding:9px 14px;font-size:12px}
.breadcrumb{padding:0 12px;margin:8px auto}
main{padding:0 10px 30px}
.card-body{padding:16px 14px}
.form-grid{grid-template-columns:1fr;gap:12px}
.notice{padding:10px 12px;font-size:12px}
.btn-main{font-size:14px;padding:13px;letter-spacing:1px}
.info-grid{grid-template-columns:1fr}
.info-cell:nth-child(2n){border-right:1px solid var(--border)}
.info-cell:nth-last-child(-n+2){border-bottom:1px solid var(--border)}
.info-cell:last-child{border-bottom:none}
table{font-size:13px}
thead th{padding:8px 10px}
tbody td{padding:7px 10px}
.hist-tab{padding:7px 12px;font-size:12px}
.back-bar{flex-direction:column;align-items:flex-start;gap:8px}
.btn-back{width:100%;text-align:center;padding:11px}
.tip{font-size:11px}
footer{padding:12px}
}
`;

    // ─── GET /  前台首页 ─────────────────────────────────────
    if (method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>加载中…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">

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
  // 用 sessionStorage 传参，避免敏感信息暴露在 URL 中
  sessionStorage.setItem("qp", JSON.stringify({examSession, uid, data:vals}));
  location.href="/result";
}
document.addEventListener("keydown",e=>{if(e.key==="Enter")go();});
</script></body></html>`);
    }

    // ─── GET /result  结果页 ─────────────────────────────────
    if (method === "GET" && url.pathname === "/result") {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>成绩查询结果</title>
<meta name="viewport" content="width=device-width,initial-scale=1">

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
// 从 sessionStorage 读取查询参数，读完即删，避免刷新重复使用
const _qp = JSON.parse(sessionStorage.getItem("qp")||"null");
sessionStorage.removeItem("qp");
const examSession = _qp?.examSession || null;
const uid         = _qp?.uid || null;
const data        = _qp?.data || {};

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

    // ─── GET /js  教师端 ─────────────────────────────────────
    if (method === "GET" && url.pathname === "/js") {
      const site = await getSite();
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>教师端 · ${site.pageTitle||"成绩查询"}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">

<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f0f2f5;--ac:#1890ff;--ac2:#096dd9;--red:#ff4d4f;--bd:#e8ecf3;--tx:#1c2438;--sub:#6b7280;--hd:#0d2447}
body{font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","WenQuanYi Micro Hei",sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}
#loginPage{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0d2447,#1251a3 50%,#0d2447)}
.lc{background:#fff;width:360px;border-radius:4px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)}
.lh{background:var(--hd);padding:28px 32px;text-align:center}.lh h1{color:#fff;font-size:18px;letter-spacing:2px;margin-bottom:4px}.lh p{color:rgba(255,255,255,.5);font-size:12px}
.lb{padding:28px 32px}.lb label{display:block;font-size:12px;color:var(--sub);margin-bottom:5px;font-weight:600}
.lb input,.lb select{width:100%;padding:10px 13px;border:1px solid var(--bd);border-radius:2px;font-size:14px;outline:none;font-family:inherit;transition:border .2s;margin-bottom:14px}
.lb input:focus,.lb select:focus{border-color:var(--ac)}
.btn-login{width:100%;padding:11px;background:var(--ac);color:#fff;border:none;font-size:14px;font-family:inherit;font-weight:600;letter-spacing:2px;cursor:pointer;border-radius:2px;transition:background .2s}
.btn-login:hover{background:var(--ac2)}.lerr{color:var(--red);font-size:13px;margin-top:8px;text-align:center;min-height:18px}
#app{display:none;min-height:100vh;flex-direction:column}
.topnav{background:var(--hd);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.topnav .logo{font-size:15px;font-weight:700;letter-spacing:1px}
.topnav .usr{font-size:13px;color:rgba(255,255,255,.65);cursor:pointer}.topnav .usr:hover{color:#fff}
.main{max-width:1200px;margin:0 auto;padding:20px 16px}
.card{background:#fff;border-radius:4px;border:1px solid var(--bd);margin-bottom:16px}
.ch{padding:13px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between}
.ch h3{font-size:14px;font-weight:600}
.cb{padding:16px 20px}
.toolbar{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.fg{display:flex;flex-direction:column;gap:4px;min-width:160px}
.fg label{font-size:12px;color:var(--sub);font-weight:600}
.fg select{padding:7px 10px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none}
.fg select:focus{border-color:var(--ac)}
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 16px;border-radius:2px;border:none;font-size:13px;font-family:inherit;cursor:pointer;font-weight:500;transition:all .15s}
.btn-p{background:var(--ac);color:#fff}.btn-p:hover{background:var(--ac2)}
.btn-g{background:#f5f5f5;color:var(--tx);border:1px solid var(--bd)}.btn-g:hover{background:#eee}
/* stats row */
.stat-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.scard{background:#fff;border:1px solid var(--bd);border-radius:4px;padding:14px 18px;flex:1;min-width:140px}
.scard .snum{font-size:22px;font-weight:700;color:var(--ac)}.scard .slbl{font-size:11px;color:var(--sub);margin-top:2px}
/* table */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f7f9fc;padding:9px 12px;text-align:left;font-weight:600;color:var(--sub);border-bottom:2px solid var(--bd);white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid var(--bd);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f7fbff}
.rank-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.rank-1{background:#fff3cd;color:#b8860b}.rank-2{background:#e8f5e9;color:#2e7d32}.rank-3{background:#e3f2fd;color:#1565c0}.rank-n{background:#f5f5f5;color:#888}
.avg-row td{background:#fffbe6;font-weight:600;color:#b45309}
.tag-hr{background:#fde8e8;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
.tag-sb{background:#e8f0fe;color:#1565c0;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
/* subj avg table */
.subj-stat{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.subj-card{background:#f7f9fc;border:1px solid var(--bd);border-radius:4px;padding:10px 14px;min-width:120px}
.subj-card .sn{font-size:20px;font-weight:700;color:var(--tx)}.subj-card .sl{font-size:11px;color:var(--sub);margin-top:1px}
.subj-card .sr{font-size:11px;color:var(--ac);font-weight:600;margin-top:3px}
@media(max-width:600px){
#loginPage{padding:16px}
.lc{width:100%;max-width:380px}
.lh{padding:20px 20px}
.lb{padding:20px 20px}
.topnav{padding:0 12px;height:48px}
.topnav .logo{font-size:13px}
.topnav .usr{font-size:12px}
.main{padding:12px 10px}
.toolbar{flex-direction:column;gap:8px}
.fg{min-width:unset;width:100%}
.stat-row{gap:8px}
.scard{min-width:calc(50% - 4px);padding:10px 12px}
.scard .snum{font-size:18px}
.subj-stat{gap:8px}
.subj-card{min-width:calc(50% - 4px);padding:8px 10px}
.cb{padding:12px}
.ch{padding:10px 14px}
table{font-size:12px}
th,td{padding:7px 8px}
}
</style></head><body>
<div id="loginPage">
  <div class="lc">
    <div class="lh"><h1>教师登录</h1><p>${site.headerSub||"成绩查询平台 · 教师专用"}</p></div>
    <div class="lb">
      <label>教师编号</label><input id="tid" type="text" placeholder="请输入编号" onkeydown="if(event.key==='Enter')q('tpwd').focus()">
      <label>密码</label><input id="tpwd" type="password" placeholder="请输入密码" onkeydown="if(event.key==='Enter')doLogin()">
      <button class="btn-login" onclick="doLogin()">登　录</button>
      <div id="lerr" class="lerr"></div>
    </div>
  </div>
</div>
<div id="app">
  <div class="topnav">
    <div class="logo">📋 教师工作台</div>
    <div class="usr" id="usrLabel" onclick="doLogout()">退出登录</div>
  </div>
  <div class="main">
    <div class="card">
      <div class="ch"><h3>查询条件</h3></div>
      <div class="cb">
        <div class="toolbar">
          <div class="fg"><label>考试批次</label><select id="sel_exam"><option value="">请选择…</option></select></div>
          <div class="fg"><label>班　级</label><select id="sel_class"><option value="">请选择…</option></select></div>
          <button class="btn btn-p" style="margin-bottom:1px" onclick="loadData()">📊 查看成绩</button>
        </div>
      </div>
    </div>
    <div id="resultArea" style="display:none">
      <div class="stat-row" id="statRow"></div>
      <div class="card">
        <div class="ch"><h3>各科班级统计</h3></div>
        <div class="cb"><div class="subj-stat" id="subjStat"></div></div>
      </div>
      <div class="card">
        <div class="ch"><h3 id="tableTitle">学生成绩</h3><span id="tableNote" style="font-size:12px;color:var(--sub)"></span></div>
        <div class="cb" style="padding:0"><div class="tw"><table id="scoreTable"><thead id="th"></thead><tbody id="tb"></tbody></table></div></div>
      </div>
    </div>
  </div>
</div>
<script>
const q=id=>document.getElementById(id);
let _tok=sessionStorage.getItem("tch_tok")||"", _teacher=JSON.parse(sessionStorage.getItem("tch_info")||"null");
let _exams=[], _data=null;

async function api(path,body){
  const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,token:_tok})});
  if(r.status===401){doLogout();return{success:false,message:"会话已过期"};}
  return r.json();
}

async function doLogin(){
  const id=q("tid").value.trim(), pw=q("tpwd").value.trim();
  if(!id||!pw){q("lerr").textContent="请填写编号和密码";return;}
  const r=await fetch("/api/teacher/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,password:pw})});
  const d=await r.json();
  if(!d.success){q("lerr").textContent=d.message;return;}
  _tok=d.token; _teacher=d.teacher;
  sessionStorage.setItem("tch_tok",_tok);
  sessionStorage.setItem("tch_info",JSON.stringify(_teacher));
  showApp();
}

function showApp(){
  q("loginPage").style.display="none";
  const app=q("app"); app.style.display="flex"; app.style.flexDirection="column";
  const typeLabel=_teacher.type==="homeroom"?\`<span class="tag-hr">班主任</span>\`:\`<span class="tag-sb">科任老师·\${_teacher.subject}</span>\`;
  q("usrLabel").innerHTML=\`\${_teacher.name||_teacher.id} \${typeLabel} 退出\`;
  loadExams();
}

async function doLogout(){
  if(_tok) await fetch("/api/teacher/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:_tok})}).catch(()=>{});
  _tok=""; _teacher=null;
  sessionStorage.removeItem("tch_tok"); sessionStorage.removeItem("tch_info");
  q("loginPage").style.display="flex"; q("app").style.display="none";
}

async function loadExams(){
  // 拿考试批次列表（复用 pub 接口的 site config）
  try{
    const r=await fetch("/api/pub/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_getExams:true})});
    const d=await r.json();
    if(d.exams){
      _exams=d.exams;
      const sel=q("sel_exam");
      sel.innerHTML=\`<option value="">请选择批次…</option>\`+_exams.map(e=>\`<option value="\${e.id}">\${e.label}</option>\`).join("");
    }
  }catch{}
  // 填充班级
  const sel=q("sel_class");
  const classes=_teacher.classes||[];
  if(classes.length===0){sel.innerHTML=\`<option value="">（未分配班级）</option>\`;return;}
  sel.innerHTML=classes.map(c=>\`<option value="\${c}">\${c}</option>\`).join("");
}

async function loadData(){
  const examId=q("sel_exam").value, cls=q("sel_class").value;
  if(!examId){alert("请选择考试批次");return;}
  if(!cls){alert("请选择班级");return;}
  const r=await api("/api/teacher/data",{examSessionId:examId,className:cls});
  if(!r.success){alert(r.message);return;}
  _data=r;
  renderResult();
}

function rankBadge(n,total){
  const cls=n===1?"rank-1":n<=3?"rank-2":n<=Math.ceil(total*0.1)?"rank-3":"rank-n";
  return \`<span class="rank-badge \${cls}">\${n}</span>\`;
}

function renderResult(){
  const d=_data;
  q("resultArea").style.display="block";

  // 统计卡片
  const classAvgTot=(d.classAvgTotal||0).toFixed(1);
  q("statRow").innerHTML=\`
    <div class="scard"><div class="snum">\${d.students.length}</div><div class="slbl">班级人数</div></div>
    <div class="scard"><div class="snum">\${d.totalStudents}</div><div class="slbl">年级总人数</div></div>
    <div class="scard"><div class="snum">\${d.classCount}</div><div class="slbl">年级班级数</div></div>
    <div class="scard"><div class="snum">\${classAvgTot}</div><div class="slbl">班级科目均分</div></div>\`;

  // 各科统计
  q("subjStat").innerHTML=d.visibleSubjects.map(subj=>{
    const avg=(d.classSubjAvg[subj]||0).toFixed(1);
    const rank=d.subjGradeRank[subj]||"-";
    return \`<div class="subj-card">
      <div class="sn">\${avg}</div>
      <div class="sl">\${subj} 班均分</div>
      <div class="sr">年级第 \${rank} / \${d.classCount} 班</div>
    </div>\`;
  }).join("");

  // 表头
  const isBoss=d.teacher.type==="homeroom";
  const subjs=d.visibleSubjects;
  q("tableTitle").textContent=\`\${d.className} · 成绩列表\`;
  q("tableNote").textContent=isBoss?"班主任视图（全科）":\`科任视图（\${d.teacher.subject}）\`;
  q("th").innerHTML=\`<tr>
    <th>姓名</th><th>准考证号</th>
    \${subjs.map(s=>\`<th>\${s}</th>\`).join("")}
    \${isBoss?\`<th>总分</th>\`:""}
    <th>班排</th><th>年排</th>
  </tr>\`;

  // 表体（按班排升序）
  const sorted=[...d.students].sort((a,b)=>a.classRank-b.classRank);
  const tbody=q("tb");
  tbody.innerHTML="";

  // 平均分行
  const avgRow=document.createElement("tr");
  avgRow.className="avg-row";
  const fields=sorted[0]?.fields||{};
  const nameKey=Object.keys(fields).find(k=>k.includes("name")||k.includes("姓"))||Object.keys(fields)[0];
  avgRow.innerHTML=\`<td colspan="2" style="font-weight:700">班级平均分</td>
    \${subjs.map(s=>\`<td>\${(d.classSubjAvg[s]||0).toFixed(1)}</td>\`).join("")}
    \${isBoss?\`<td>—</td>\`:""}
    <td colspan="2">—</td>\`;
  tbody.appendChild(avgRow);

  sorted.forEach(stu=>{
    const tr=document.createElement("tr");
    const nameVal=stu.fields[nameKey]||"—";
    tr.innerHTML=\`<td>\${nameVal}</td><td style="color:var(--sub);font-size:12px">\${stu.uid}</td>
      \${subjs.map(s=>\`<td>\${stu.scores[s]??"-"}</td>\`).join("")}
      \${isBoss?\`<td style="font-weight:700">\${stu.total}</td>\`:""}
      <td>\${rankBadge(stu.classRank,d.students.length)}</td>
      <td>\${rankBadge(stu.gradeRank,d.totalStudents)}</td>\`;
    tbody.appendChild(tr);
  });
}

// 自动恢复登录
if(_tok&&_teacher){ showApp(); } else { q("loginPage").style.display="flex"; }
</script></body></html>`);
    }

    if (method === "GET" && url.pathname === "/admin") {
      return html(`<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>后台管理</title>
<meta name="viewport" content="width=device-width,initial-scale=1">

<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f0f2f5;--sb:#0d2447;--sb2:#162d52;--ac:#1890ff;--ac2:#096dd9;--red:#ff4d4f;--green:#52c41a;--gold:#faad14;--bd:#e8ecf3;--tx:#1c2438;--sub:#6b7280}
body{font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","WenQuanYi Micro Hei",sans-serif;background:var(--bg);color:var(--tx);min-height:100vh}
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
@media(max-width:768px){
#loginPage{padding:16px}
.lc{width:100%;max-width:380px}
.layout{flex-direction:column;height:auto}
.sb{width:100%;display:flex;flex-wrap:wrap;padding:4px 8px;gap:0}
.sb-sec{display:none}
.sb a{padding:7px 10px;font-size:12px;border-left:none;border-bottom:2px solid transparent;flex-shrink:0}
.sb a.active{border-bottom-color:var(--ac);border-left:none;background:rgba(24,144,255,.1)}
.content{padding:12px 10px;overflow-y:unset;height:auto}
.topnav{padding:0 12px;height:48px}
.topnav .logo{font-size:13px}
.topnav .logo-ico{width:24px;height:24px;font-size:12px}
.topnav .usr{font-size:12px}
.g2,.g3,.g4{grid-template-columns:1fr 1fr}
.stat3{grid-template-columns:1fr}
.field-row{grid-template-columns:1fr 1fr;gap:8px}
.exam-row .er-info{grid-template-columns:1fr 1fr}
.lh{padding:20px}
.lb{padding:20px}
.cb{padding:12px}
.ch{padding:10px 14px;flex-wrap:wrap;gap:6px}
table{font-size:12px}
th,td{padding:7px 8px}
}
@media(max-width:480px){
.g2,.g3,.g4{grid-template-columns:1fr}
.exam-row .er-info{grid-template-columns:1fr}
.field-row{grid-template-columns:1fr}
.scard{flex-direction:column;gap:6px;align-items:flex-start}
}
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
      <div class="sb-sec">账号管理</div>
      <a onclick="go('teachers')"><span class="ico">👨‍🏫</span>教师账号</a>
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
          <div class="ch"><h3>各批次录入情况</h3><span style="font-size:12px;color:var(--sub)">点击批次可展开编辑</span></div>
          <div class="cb" style="padding:0"><div id="st_detail"></div></div>
        </div>
      </div>

      <!-- ══ 教师账号 ══ -->
      <div id="tab-teachers" class="tab">
        <div class="card">
          <div class="ch"><h3>添加教师账号</h3></div>
          <div class="cb">
            <div class="g3" style="margin-bottom:12px">
              <div class="fg"><label>教师编号 *</label><input id="tc_id" placeholder="如 T001"></div>
              <div class="fg"><label>姓名</label><input id="tc_name" placeholder="如 张老师"></div>
              <div class="fg"><label>密码 *</label><input id="tc_pw" type="password" placeholder="登录密码"></div>
            </div>
            <div class="g3" style="margin-bottom:16px">
              <div class="fg">
                <label>账号类型 *</label>
                <select id="tc_type" onchange="tcTypeChange()">
                  <option value="subject">科任老师</option>
                  <option value="homeroom">班主任</option>
                </select>
              </div>
              <div class="fg" id="tc_subj_wrap">
                <label>负责科目 *</label>
                <select id="tc_subj"><option value="">请选择…</option></select>
              </div>
              <div class="fg">
                <label>管理班级（多选）</label>
                <div id="tc_classes" style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0;min-height:32px"></div>
              </div>
            </div>
            <button class="btn btn-p" onclick="tcAdd()">➕ 添加教师</button>
            <span id="tc_err" style="color:var(--red);font-size:13px;margin-left:12px"></span>
          </div>
        </div>
        <div class="card">
          <div class="ch"><h3>教师列表</h3><button class="btn btn-g sm" onclick="tcLoad()">↺ 刷新</button></div>
          <div class="cb" style="padding:0">
            <div class="tw"><table>
              <thead><tr><th>编号</th><th>姓名</th><th>类型</th><th>科目</th><th>管理班级</th><th>操作</th></tr></thead>
              <tbody id="tc_body"></tbody>
            </table></div>
          </div>
        </div>
        <div class="card" style="border-left:4px solid #faad14">
          <div class="cb" style="font-size:13px;color:var(--sub);line-height:2">
            🔗 教师登录入口：<strong style="color:var(--tx)">/js</strong>（如：<span id="tc_url"></span>）<br>
            📌 班主任可查看所有科目成绩；科任老师仅能查看自己负责的科目。<br>
            ⚠️ 教师账号只有查看权限，无法修改学生成绩。
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- 编辑浮层 Modal -->
<div id="editModal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);overflow-y:auto;padding:24px 16px" onclick="if(event.target===this)closeModal()">
  <div style="max-width:680px;margin:0 auto;background:var(--bg);border-radius:4px;box-shadow:0 8px 40px rgba(0,0,0,.18)">
    <div class="ch" style="padding:16px 20px;position:sticky;top:0;background:var(--bg);z-index:1;border-bottom:1px solid var(--bd)">
      <h3 id="modalTitle">编辑成绩</h3>
      <button class="btn btn-g sm" onclick="closeModal()">✕ 关闭</button>
    </div>
    <div class="cb" id="modalBody" style="padding:20px"></div>
  </div>
</div>

<script>
let pwd="", cfg={site:{},fields:[],directions:[],exams:[]}, allScores=[];
const esc=(t)=>String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
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
  const tabs=["scores","add","import","exams","fields","directions","site","stats","teachers"];
  document.querySelectorAll(".sb a")[tabs.indexOf(tab)]?.classList.add("active");
  if(tab==="exams")    renderExamList();
  if(tab==="fields")   renderFieldList();
  if(tab==="directions") renderDirList();
  if(tab==="site")     renderSiteForm();
  if(tab==="stats")    renderStats();
  if(tab==="add")      {renderAddDyn(); renderAddSubj();}
  if(tab==="teachers") tcInit();
}

// ═══════════════════════════════════════════════
//  教师账号管理
// ═══════════════════════════════════════════════
function tcInit(){
  // 显示教师登录 URL
  const urlEl=q("tc_url");
  if(urlEl) urlEl.textContent=location.origin+"/js";
  // 填充科目选择
  const subjSel=q("tc_subj");
  if(subjSel){
    const subjs=[...new Set(cfg.directions.flatMap(d=>d.subjects||[]))];
    subjSel.innerHTML=\`<option value="">请选择…</option>\`+subjs.map(s=>\`<option value="\${s}">\${s}</option>\`).join("");
  }
  // 填充班级复选框（从字段配置里找班级字段的可选值）
  const classField=cfg.fields.find(f=>f.label.includes("班")||f.id.includes("class"));
  const classBox=q("tc_classes");
  if(classBox){
    // 班级选项：从已有成绩里取，或从字段 options 取
    const opts=classField?.options||[];
    if(opts.length){
      classBox.innerHTML=opts.map(c=>
        \`<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;background:#f5f5f5;padding:3px 8px;border-radius:2px">
          <input type="checkbox" value="\${c}" style="width:auto"> \${c}
        </label>\`
      ).join("");
    } else {
      classBox.innerHTML=\`<span style="font-size:12px;color:var(--sub)">请先在"查询字段"中为班级字段添加可选项，或手动填写</span>
        <input id="tc_classes_manual" placeholder="逗号分隔，如 高一1班,高一2班" style="margin-top:6px;width:100%;padding:6px 10px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none">\`;
    }
  }
  tcLoad();
}

function tcTypeChange(){
  const t=q("tc_type")?.value;
  const wrap=q("tc_subj_wrap");
  if(wrap) wrap.style.display=t==="homeroom"?"none":"";
}

function tcGetClasses(){
  const manual=q("tc_classes_manual");
  if(manual) return manual.value.split(",").map(s=>s.trim()).filter(Boolean);
  return [...document.querySelectorAll("#tc_classes input[type=checkbox]:checked")].map(c=>c.value);
}

async function tcAdd(){
  const id=q("tc_id").value.trim();
  const name=q("tc_name").value.trim();
  const pw=q("tc_pw").value.trim();
  const type=q("tc_type").value;
  const subject=q("tc_subj")?.value||"";
  const classes=tcGetClasses();
  const err=q("tc_err");
  err.textContent="";
  if(!id||!pw){err.textContent="编号和密码不能为空";return;}
  if(type==="subject"&&!subject){err.textContent="请选择负责科目";return;}
  if(!classes.length){err.textContent="请至少选择一个班级";return;}
  const r=await api("/api/admin/teacher",{action:"add",id,name,password:pw,type,subject,classes});
  if(!r.success){err.textContent=r.message;return;}
  q("tc_id").value=""; q("tc_name").value=""; q("tc_pw").value="";
  tcLoad();
}

async function tcDelete(id, name){
  const confirmed=confirm(
    \`⚠️ 确认删除教师账号？\n\n编号：\${id}  姓名：\${name||id}\n\n后果：\n· 该账号将立即无法登录教师端\n· 已登录的 token 将在自然过期前仍有效（最长8小时）\n· 此操作不可撤销\`
  );
  if(!confirmed) return;
  const r=await api("/api/admin/teacher",{action:"delete",id});
  if(!r.success){alert("删除失败："+r.message);return;}
  tcLoad();
}

async function tcLoad(){
  const tbody=q("tc_body");
  if(!tbody) return;
  tbody.innerHTML=\`<tr><td colspan="6" style="text-align:center;color:var(--sub);padding:16px">加载中…</td></tr>\`;
  const r=await api("/api/admin/teacher",{action:"list"});
  if(!r.success){tbody.innerHTML=\`<tr><td colspan="6" style="color:red;padding:12px">\${r.message}</td></tr>\`;return;}
  if(!r.data.length){tbody.innerHTML=\`<tr><td colspan="6" style="text-align:center;color:var(--sub);padding:16px">暂无教师账号</td></tr>\`;return;}
  tbody.innerHTML=r.data.map(t=>\`<tr>
    <td><strong>\${t.id}</strong></td>
    <td>\${t.name||"—"}</td>
    <td>\${t.type==="homeroom"?'<span style="background:#fde8e8;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">班主任</span>':'<span style="background:#e8f0fe;color:#1565c0;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">科任老师</span>'}</td>
    <td>\${t.subject||"（全科）"}</td>
    <td style="font-size:12px">\${(t.classes||[]).join("、")||"—"}</td>
    <td><button class="btn btn-d sm" onclick="tcDelete('\${t.id}','\${t.name||t.id}')">🗑 删除</button></td>
  </tr>\`).join("");
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
function closeModal(){
  q("editModal").style.display="none";
  document.body.style.overflow="";
}
function openModal(title, bodyHtml){
  q("modalTitle").textContent=title;
  q("modalBody").innerHTML=bodyHtml;
  q("editModal").style.display="block";
  document.body.style.overflow="hidden";
}
function editScore(item){
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
  openModal("编辑成绩记录",\`
    <div class="g3" style="margin-bottom:14px">\${fieldInputs}
      <div class="fg"><label>考试方向</label><select id="e_dir" onchange="reloadEditSubj('\${item.examSessionId}','\${uid}')">\${dirOpts}</select></div>
    </div>
    <div style="padding-top:12px;border-top:1px solid var(--bd)">
      <div style="font-size:12px;color:var(--sub);margin-bottom:8px;font-weight:600">各科成绩</div>
      <div class="g4" id="e_subj">\${subjInputs}</div>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;align-items:center">
      <button class="btn btn-p" onclick="saveEdit('\${item.examSessionId}','\${uid}')">💾 保存</button>
      <button class="btn btn-g" onclick="closeModal()">取消</button>
      <span id="editMsg" class="msg"></span>
    </div>
  \`);
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
  if(r.success){
    await loadScores();
    closeModal();
    // 若统计页展开着，刷新对应批次
    const panel=q("ep_"+examSessionId);
    if(panel&&panel.style.display!=="none") renderExamPanel(examSessionId);
  } else {
    showMsg("editMsg",r.message,"er");
  }
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
  cfg.exams.forEach(e=>{byExam[e.id]=[];});
  list.forEach(x=>{ if(byExam[x.examSessionId]) byExam[x.examSessionId].push(x); });
  const total=list.length||1;

  q("st_detail").innerHTML=cfg.exams.map(e=>{
    const cnt=(byExam[e.id]||[]).length, pct=Math.round(cnt/total*100);
    return \`<div style="border-bottom:1px solid var(--bd)">
      <div onclick="toggleExamPanel('\${e.id}')" style="display:flex;align-items:center;gap:12px;padding:14px 20px;cursor:pointer;user-select:none;transition:background .15s" onmouseover="this.style.background='var(--blue3)'" onmouseout="this.style.background=''">
        <span id="ep_arr_\${e.id}" style="font-size:11px;color:var(--sub);transition:transform .2s">▶</span>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <span style="font-weight:600">\${e.label}</span>
            <span style="font-size:13px;color:var(--sub)">\${cnt} 人 · \${pct}%</span>
          </div>
          <div style="background:#f0f0f0;border-radius:2px;height:6px;overflow:hidden">
            <div style="background:var(--ac);width:\${pct}%;height:100%;border-radius:2px"></div>
          </div>
        </div>
      </div>
      <div id="ep_\${e.id}" style="display:none;padding:0 20px 16px"></div>
    </div>\`;
  }).join("")||"<p style='color:#bbb;padding:20px'>暂无数据</p>";
}

function toggleExamPanel(examId){
  const panel=q("ep_"+examId);
  const arr=q("ep_arr_"+examId);
  if(panel.style.display==="none"){
    panel.style.display="block";
    arr.style.transform="rotate(90deg)";
    renderExamPanel(examId);
  } else {
    panel.style.display="none";
    arr.style.transform="";
  }
}

function renderExamPanel(examId){
  const panel=q("ep_"+examId);
  panel.innerHTML=\`<div style="color:var(--sub);font-size:13px;padding:8px 0">加载中…</div>\`;
  api("/api/admin/score",{action:"list",examSessionId:examId}).then(r=>{
    if(!r.success){panel.innerHTML=\`<p style='color:red'>加载失败：\${r.message||"未知错误"}</p>\`;return;}
    const items=r.data;
    if(!items.length){panel.innerHTML="<p style='color:#bbb;font-size:13px;padding:8px 0'>该批次暂无成绩记录</p>";return;}
    panel.innerHTML=\`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <span style="font-size:13px;color:var(--sub)">共 \${items.length} 条，直接修改后点右下角保存</span>
        <button class="btn btn-g sm" onclick="renderExamPanel('\${examId}')">↺ 刷新</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
        \${items.map(item=>renderStudentCard(item,examId)).join("")}
      </div>\`;
  }).catch(e=>{ panel.innerHTML=\`<p style='color:red'>请求异常：\${e.message}</p>\`; });
}

function renderStudentCard(item, examId){
  const uidField=cfg.fields.find(f=>f.isUid);
  const nameField=cfg.fields.find(f=>!f.isUid&&(f.label.includes("姓名")||f.id.includes("name")))||cfg.fields.find(f=>!f.isUid);
  const dir=cfg.directions.find(d=>d.id===item.direction);
  const uid=uidField?item.fields?.[uidField.id]:item.uid;
  const name=nameField?item.fields?.[nameField.id]||"—":"—";
  const cardId="sc_"+examId+"_"+item.uid;
  const infoFields=cfg.fields.filter(f=>!f.isUid&&!f.isVerify);
  const dirOpts=cfg.directions.map(d=>
    \`<option value="\${d.id}" \${d.id===item.direction?"selected":""}>\${d.label}</option>\`
  ).join("");
  const subjects=dir?dir.subjects:[];
  const scoreRows=subjects.map(s=>
    \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--sub);min-width:64px;flex-shrink:0">\${esc(s)}</span>
      <input class="sc-inp" data-subj="\${esc(s)}" type="number" value="\${Number(item.scores?.[s]||0)}"
        style="width:80px;padding:4px 8px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none"
        oninput="scCardDirty('\${cardId}')">
    </div>\`
  ).join("");
  const fieldRows=infoFields.map(f=>
    \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--sub);min-width:64px;flex-shrink:0">\${esc(f.label)}</span>
      <input class="fi-inp" data-fid="\${f.id}" type="text" value="\${esc(item.fields?.[f.id]||"")}"
        style="flex:1;padding:4px 8px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none"
        oninput="scCardDirty('\${cardId}')">
    </div>\`
  ).join("");
  return \`<div id="\${cardId}" style="border:1px solid var(--bd);border-radius:4px;background:var(--bg);overflow:hidden;transition:box-shadow .2s">
    <div style="padding:12px 14px 10px;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700;font-size:14px">\${esc(name)}</div>
        <div style="font-size:11px;color:var(--sub);margin-top:2px">\${esc(uid)}</div>
      </div>
      <span id="\${cardId}_badge" style="font-size:11px;color:var(--sub);background:var(--bd);padding:2px 8px;border-radius:10px">\${esc(dir?.label||"—")}</span>
    </div>
    <div style="padding:12px 14px">
      \${fieldRows?fieldRows+"<div style='height:6px'></div>":""}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:12px;color:var(--sub);min-width:64px;flex-shrink:0">考试方向</span>
        <select class="dir-sel" onchange="scCardChangeDir('\${cardId}',this.value)"
          style="flex:1;padding:4px 8px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none">
          \${dirOpts}
        </select>
      </div>
      <div class="score-rows" id="\${cardId}_scores">\${scoreRows}</div>
    </div>
    <div style="padding:8px 14px 12px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--bd)">
      <button class="btn btn-d sm" onclick="scCardDelete('\${cardId}','\${examId}','\${item.uid}')">🗑 删除</button>
      <button id="\${cardId}_save" class="btn btn-p sm" onclick="scCardSave('\${cardId}','\${examId}','\${item.uid}')">保存</button>
    </div>
  </div>\`;
}

function scCardDirty(cardId){
  const btn=q(cardId+"_save");
  if(btn){ btn.textContent="💾 保存 *"; }
}

function scCardChangeDir(cardId, dirId){
  scCardDirty(cardId);
  const dir=cfg.directions.find(d=>d.id===dirId);
  const badge=q(cardId+"_badge"); if(badge) badge.textContent=dir?.label||"—";
  const container=q(cardId+"_scores");
  if(!container||!dir) return;
  container.innerHTML=dir.subjects.map(s=>
    \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;color:var(--sub);min-width:64px;flex-shrink:0">\${esc(s)}</span>
      <input class="sc-inp" data-subj="\${esc(s)}" type="number" value="0"
        style="width:80px;padding:4px 8px;border:1px solid var(--bd);border-radius:2px;font-size:13px;font-family:inherit;outline:none"
        oninput="scCardDirty('\${cardId}')">
    </div>\`
  ).join("");
}

async function scCardSave(cardId, examId, uid){
  const card=q(cardId); const btn=q(cardId+"_save");
  if(!card||!btn) return;
  btn.textContent="保存中…"; btn.disabled=true;
  const direction=card.querySelector(".dir-sel")?.value||"";
  const scores={}; card.querySelectorAll(".sc-inp").forEach(inp=>{ scores[inp.dataset.subj]=Number(inp.value)||0; });
  const fields={}; const uidField=cfg.fields.find(f=>f.isUid); if(uidField) fields[uidField.id]=uid;
  card.querySelectorAll(".fi-inp").forEach(inp=>{ fields[inp.dataset.fid]=inp.value.trim(); });
  const r=await api("/api/admin/score",{action:"upsert",examSessionId:examId,uid,direction,scores,fields});
  if(r.success){
    btn.textContent="✅ 已保存"; btn.disabled=false;
    setTimeout(()=>{ btn.textContent="保存"; },2000);
  } else {
    btn.textContent="❌ 失败"; btn.disabled=false;
    setTimeout(()=>{ btn.textContent="💾 保存 *"; },2000);
  }
}

async function scCardDelete(cardId, examId, uid){
  if(!confirm("确认删除该学生记录？")) return;
  const r=await api("/api/admin/score",{action:"delete",examSessionId:examId,uid});
  if(r.success){
    const card=q(cardId);
    if(card){ card.style.opacity="0"; card.style.transition="opacity .3s"; setTimeout(()=>card.remove(),300); }
  } else { alert("删除失败："+r.message); }
}
</script>
<script src="/admin-import.js"></script>
</body></html>`);
    }

    // ─── GET /admin-import.js  批量导入脚本 ─────────────────
    if (method === "GET" && url.pathname === "/admin-import.js") {
      const importJS = String.raw`
/* ══════════════════════════════════════════════════════════════
   批量导入脚本 v2  —  智能兼容各类学校成绩单格式
   ══════════════════════════════════════════════════════════════
   新增能力：
   1. 自动跳过"平均分/汇总"等统计行
   2. 自动过滤"班次/校次/名次/排名"等非成绩列
   3. 识别"-""—"等无成绩占位符，跳过而非报错
   4. 成绩支持小数（82.5）、分数段（A/B）
   5. 无方向列时，根据各行有成绩的科目集合自动推断方向
   6. 推断时优先精确全集匹配，其次最大交集匹配
   7. 手动选择"自动推断方向"后预览实时更新
   8. 多 sheet 时弹出选择
   9. 考号/准考证/学号等别名大幅扩充
   10. 总分/合计列自动忽略
   ══════════════════════════════════════════════════════════════ */

let im_rawRows=[], im_headers=[], im_colMap=[], im_allParsedSubjects=[];

/* ── 工具函数 ──────────────────────────────────────────────── */

// 标准化字符串：去空白全角、转小写
function norm(s){ return String(s||"").trim().replace(/[\s\u3000]+/g,"").toLowerCase(); }

// 判断一个字符串是否是"无成绩"占位符
function isEmptyScore(v){
  const s=String(v||"").trim();
  return s===""||s==="-"||s==="—"||s==="--"||s==="缺考"||s==="作弊"||s==="免考"||s==="*";
}

// 判断一行是否是统计/汇总行（应跳过）
function isSummaryRow(row, uidColIdx){
  const nameCol=String(row[0]||"").trim();
  const summaryNames=["平均分","最高分","最低分","总计","合计","班平均","年级平均","参考人数","应考人数","实考人数","标准差","及格率","优秀率","备注"];
  for(const n of summaryNames){ if(nameCol.includes(n)) return true; }
  if(uidColIdx>=0){
    const uid=String(row[uidColIdx]||"").trim();
    if(!uid||uid==="—"||uid==="-") return true;
  }
  return false;
}

// 判断列名是否是排名/次序列（应自动忽略）
const RANK_PATTERNS=["班次","校次","年级次","班名次","校名次","名次","排名","rank","class_rank","grade_rank","总分名次","总分班次","总分校次"];
function isRankColumn(header){
  const h=norm(header);
  if(!h) return true;
  // "班次/校次" 这类复合名也要命中
  return RANK_PATTERNS.some(p=>h===norm(p)||h.includes(norm(p)));
}

// 判断列名是否是总分/合计列（应自动忽略）
const TOTAL_PATTERNS=["总分","合计","总计","total","sum","综合分","总成绩"];
function isTotalColumn(header){
  const h=norm(header);
  return TOTAL_PATTERNS.some(p=>h===norm(p)||h===p);
}

// 把成绩值解析为数字（支持小数、整数；等级制返回字符串；无成绩返回 undefined；非法返回 null）
function parseScore(v){
  const s=String(v||"").trim();
  if(isEmptyScore(s)) return undefined;
  const cleaned=s.replace(/分$/,"").trim();
  const n=Number(cleaned);
  if(!isNaN(n)) return n;
  if(/^[a-eA-E][+\-＋－]?$/.test(s)||/^[优良中差不及格]+$/.test(s)) return s;
  return null;
}

/* ── 方向推断 ──────────────────────────────────────────────── */

function inferDirection(scoredSubjects){
  if(!scoredSubjects.length) return null;
  const scored=new Set(scoredSubjects);
  let bestId=null, bestScore=-1;
  for(const d of cfg.directions){
    const ds=new Set(d.subjects||[]);
    let inter=0; for(const s of scored){ if(ds.has(s)) inter++; }
    if(inter===scored.size && inter===ds.size) return d.id;
    const ratio= ds.size>0 ? inter/ds.size : 0;
    const penalty= scored.size>ds.size ? (scored.size-inter)*0.3 : 0;
    const sc=ratio - penalty;
    if(sc>bestScore){ bestScore=sc; bestId=d.id; }
  }
  return bestScore>0.3 ? bestId : null;
}

function matchDirection(val){
  const v=norm(val);
  if(!v||v==="-"||v==="—") return null;
  for(const d of cfg.directions){ if(norm(d.id)===v||norm(d.label)===v) return d.id; }
  for(const d of cfg.directions){
    if(norm(d.label).includes(v)||v.includes(norm(d.label))) return d.id;
    if(norm(d.id).includes(v)||v.includes(norm(d.id))) return d.id;
  }
  return null;
}

/* ── 列匹配规则 ──────────────────────────────────────────────── */

function buildMatchRules(){
  const rules=[];
  cfg.fields.forEach(f=>{
    const aliases=[norm(f.label), norm(f.id), norm(f.placeholder||"")].filter(Boolean);
    if(f.isUid) aliases.push("准考证","考号","准考证号","examid","uid","id","学号","考生编号","报名号","编号","座位号","考籍号");
    if(norm(f.label).includes("姓名")||norm(f.id).includes("name")) aliases.push("姓名","名字","name","考生姓名","学生姓名");
    if(norm(f.label).includes("班")||norm(f.id).includes("class")) aliases.push("班级","班","class","所在班级","行政班");
    if(norm(f.label).includes("学校")||norm(f.id).includes("school")) aliases.push("学校","学校名称","school","单位","就读学校");
    rules.push({ type:"field", fieldId:f.id, label:f.label, aliases:[...new Set(aliases)] });
  });
  rules.push({ type:"direction", fieldId:"__direction__", label:"方向",
    aliases:["方向","考试方向","direction","dir","类别","专业方向","track","选科方向","科类","文理"] });
  const allSubjects=[...new Set(cfg.directions.flatMap(d=>d.subjects))];
  allSubjects.forEach(s=>{
    rules.push({ type:"subject", fieldId:"__subj__"+s, label:s, aliases:[norm(s)] });
  });
  return rules;
}

function matchColumn(header, rules){
  if(isRankColumn(header)) return { type:"skip", fieldId:"__rank__", label:"排名列", confidence:"exact" };
  if(isTotalColumn(header)) return { type:"skip", fieldId:"__total__", label:"总分列", confidence:"exact" };
  const h=norm(header);
  if(!h) return { type:"skip", fieldId:"__empty__", label:"空列", confidence:"exact" };
  for(const r of rules){ if(r.type!=="skip"&&r.aliases.some(a=>a===h)) return {...r, confidence:"exact"}; }
  for(const r of rules){ if(r.type!=="skip"&&r.aliases.some(a=>h.includes(a)||a.includes(h))) return {...r, confidence:"fuzzy"}; }
  if(h) return { type:"subject", fieldId:"__subj__"+header.trim(), label:header.trim(), aliases:[h], confidence:"unknown" };
  return null;
}

/* ── 文件处理 ──────────────────────────────────────────────── */

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
  const wb=XLSX.read(buf,{type:"array",cellText:true,cellDates:false});
  let sheetName=wb.SheetNames[0];
  if(wb.SheetNames.length>1){
    const choice=await pickSheet(wb.SheetNames);
    if(!choice){ q("im_parsing").style.display="none"; return; }
    sheetName=choice;
  }
  const ws=wb.Sheets[sheetName];
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:true});
  if(!rows.length) throw new Error("表格为空");
  // 找表头行（跳过列数很少的大标题行）
  let headerRowIdx=0;
  const maxCols=Math.max(...rows.slice(0,5).map(r=>r.length));
  for(let i=0;i<Math.min(5,rows.length);i++){
    if(rows[i].filter(c=>String(c||"").trim()).length >= maxCols*0.5){ headerRowIdx=i; break; }
  }
  im_headers=rows[headerRowIdx].map(h=>String(h||"").trim());
  const dataRows=rows.slice(headerRowIdx+1).filter(r=>r.some(c=>String(c||"").trim()));
  const rules=buildMatchRules();
  const tmpMap=im_headers.map(h=>matchColumn(h,rules));
  const uidColIdx=tmpMap.findIndex(m=>m&&m.type==="field"&&cfg.fields.find(f=>f.id===m.fieldId&&f.isUid));
  im_rawRows=dataRows.filter(r=>!isSummaryRow(r, uidColIdx));
  q("im_parsing").style.display="none";
  buildColMapUI();
}

function pickSheet(names){
  return new Promise(res=>{
    const overlay=document.createElement("div");
    overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center";
    const box=document.createElement("div");
    box.setAttribute("data-overlay","");
    box.style.cssText="background:#fff;border-radius:6px;padding:24px 28px;min-width:280px;max-width:400px";
    box.innerHTML="<div style='font-size:15px;font-weight:700;margin-bottom:14px'>选择要导入的 Sheet</div>"
      +names.map(n=>"<button data-name='"+n+"' style='display:block;width:100%;text-align:left;padding:9px 14px;margin-bottom:6px;border:1px solid #d0d7e6;border-radius:4px;background:#fafbff;cursor:pointer;font-size:13px;font-family:inherit'>"+n+"</button>").join("")
      +"<button data-name='__cancel__' style='margin-top:4px;padding:6px 14px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;color:#666'>取消</button>";
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.addEventListener("click",e=>{
      const btn=e.target.closest("[data-name]");
      if(!btn) return;
      document.body.removeChild(overlay);
      res(btn.dataset.name==="__cancel__"?null:btn.dataset.name);
    });
  });
}

async function parseTextFile(file, ext){
  const text=await file.text();
  const lines=text.split(/\r?\n/).filter(l=>l.trim());
  if(!lines.length) throw new Error("文件为空");
  const delimiters=[{sep:"\t"},{sep:","},{sep:"|"},{sep:";"}];
  let best=delimiters[0], bestCount=0;
  for(const d of delimiters){ const c=(lines[0].split(d.sep).length-1); if(c>bestCount){bestCount=c;best=d;} }
  const split=bestCount>0?(l=>l.split(best.sep)):(l=>l.trim().split(/\s{2,}/));
  im_headers=split(lines[0]).map(h=>h.trim());
  const rules=buildMatchRules();
  const tmpMap=im_headers.map(h=>matchColumn(h,rules));
  const uidColIdx=tmpMap.findIndex(m=>m&&m.type==="field"&&cfg.fields.find(f=>f.id===m.fieldId&&f.isUid));
  im_rawRows=lines.slice(1).map(l=>split(l).map(c=>c.trim())).filter(r=>r.some(c=>c)&&!isSummaryRow(r,uidColIdx));
  q("im_parsing").style.display="none";
  buildColMapUI();
}

/* ── 列映射 UI ──────────────────────────────────────────────── */

function buildColMapUI(){
  const rules=buildMatchRules();
  im_colMap=im_headers.map(h=>({ header:h, match:matchColumn(h,rules) }));
  const knownSubjects=[...new Set(cfg.directions.flatMap(d=>d.subjects))];
  const allOptions=[
    "<option value='__skip__'>— 忽略此列 —</option>",
    "<optgroup label='学生信息'>",
    ...cfg.fields.map(f=>"<option value='field:"+f.id+"'>"+f.label+"</option>"),
    "</optgroup>",
    "<optgroup label='特殊'>",
    "<option value='direction:'>考试方向（明确列）</option>",
    "<option value='direction:__auto__'>✨ 自动推断方向</option>",
    "</optgroup>",
    "<optgroup label='科目成绩'>",
    ...knownSubjects.map(s=>"<option value='subj:"+s+"'>"+s+"</option>"),
    "<option value='subj:__custom__'>（自定义科目，用列名）</option>",
    "</optgroup>",
  ].join("");

  const rows=im_colMap.map((c,i)=>{
    const m=c.match;
    let color="var(--sub)", badge="";
    if(m){
      if(m.type==="skip"){ color="#bbb"; badge="<span style='color:#bbb;font-size:11px'>⏭ 自动跳过</span>"; }
      else if(m.confidence==="exact"){ color="var(--green)"; badge="<span style='color:var(--green);font-size:11px'>✅ 自动识别</span>"; }
      else if(m.confidence==="fuzzy"){ color="var(--gold)"; badge="<span style='color:var(--gold);font-size:11px'>⚠️ 请确认</span>"; }
      else { color="var(--red)"; badge="<span style='color:var(--red);font-size:11px'>❓ 未知列</span>"; }
    }
    const example=String(im_rawRows[0]?.[i]||"").trim();
    return "<tr><td style='padding:7px 12px;font-weight:600;color:"+color+";white-space:nowrap'>"+c.header+"</td>"
      +"<td style='padding:7px 12px'>"+badge+"</td>"
      +"<td style='padding:7px 12px'><select id='cm_"+i+"' style='padding:5px 8px;border:1px solid var(--bd);border-radius:2px;font-size:12px;font-family:inherit;outline:none;min-width:160px'>"+allOptions+"</select></td>"
      +"<td style='padding:7px 12px;font-size:11px;color:#aaa'>"+example+"</td></tr>";
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
      if(m.type==="skip") val="__skip__";
      else if(m.type==="field") val="field:"+m.fieldId;
      else if(m.type==="direction") val="direction:";
      else {
        const rawSubj=m.fieldId.replace("__subj__","");
        val="subj:"+rawSubj;
        // 若下拉里没有此选项（新科目），追加
        if(!sel.querySelector("[value='"+val+"']")){
          const opt=document.createElement("option");
          opt.value=val; opt.textContent=im_colMap[i].header+"（新科目）";
          sel.appendChild(opt);
        }
      }
    }
    sel.value=val;
  });

  // 无方向列时提示
  const hasDirectionCol=im_colMap.some((_,i)=>{ const v=q("cm_"+i)?.value||""; return v==="direction:"; });
  if(!hasDirectionCol){
    const tip=document.createElement("div");
    tip.style.cssText="background:#fffbe6;border:1px solid #ffe58f;border-radius:4px;padding:10px 14px;font-size:12px;color:#7c6000;margin-bottom:10px";
    tip.innerHTML="💡 <strong>未检测到方向列</strong> — 将根据每行有成绩的科目自动推断考试方向";
    const tbl=q("im_mapTable");
    tbl.parentNode.insertBefore(tip, tbl);
  }

  q("im_mapArea").style.display="block";
}

/* ── 预览 ──────────────────────────────────────────────────── */

function renderImportPreview(){
  const finalMap=im_colMap.map((_,i)=>({ header:im_colMap[i].header, mapped:q("cm_"+i)?.value||"__skip__" }));
  const hasExplicitDir=finalMap.some(c=>c.mapped==="direction:");
  const knownSubjects=new Set(cfg.directions.flatMap(d=>d.subjects));

  const parsed=im_rawRows.map((row,ri)=>{
    const fields={}, scores={};
    let direction=null, dirRaw="", warnings=[];
    finalMap.forEach((col,ci)=>{
      const val=String(row[ci]??""  ).trim();
      if(col.mapped==="__skip__") return;
      if(col.mapped.startsWith("field:")){
        const fid=col.mapped.replace("field:","");
        fields[fid]=val;
      } else if(col.mapped==="direction:"){
        dirRaw=val;
        direction=matchDirection(val);
        if(val&&!isEmptyScore(val)&&!direction) warnings.push("方向\""+val+"\"未匹配，将留空");
      } else if(col.mapped.startsWith("subj:")){
        let subj=col.mapped.replace("subj:","");
        if(subj==="__custom__") subj=col.header;
        if(isEmptyScore(val)) return;
        const ps=parseScore(val);
        if(ps===null) warnings.push("「"+subj+"」值「"+val+"」非数字");
        else if(ps!==undefined) scores[subj]=ps;
      }
    });
    if(!direction){
      const scoredKnown=Object.keys(scores).filter(s=>knownSubjects.has(s));
      const inferred=inferDirection(scoredKnown);
      if(inferred){
        direction=inferred;
        dirRaw="✨ 自动："+( cfg.directions.find(d=>d.id===inferred)?.label||inferred);
      }
    }
    const uidField=cfg.fields.find(f=>f.isUid);
    const uid=uidField?(fields[uidField.id]||""):"";
    if(!uid) warnings.push("uid为空");
    return { fields, direction, dirRaw, scores, uid, warnings, rowIdx:ri+2 };
  });

  const okCount=parsed.filter(r=>!r.warnings.length).length;
  const warnCount=parsed.filter(r=>r.warnings.length&&r.uid).length;
  const errCount=parsed.filter(r=>!r.uid).length;
  const autoInfCount=parsed.filter(r=>r.dirRaw&&r.dirRaw.startsWith("✨")).length;
  q("im_summary").innerHTML="共 <strong>"+parsed.length+"</strong> 行 · <span style='color:var(--green)'>✅ "+okCount+" 正常</span> · <span style='color:var(--gold)'>⚠️ "+warnCount+" 警告</span> · <span style='color:var(--red)'>❌ "+errCount+" 错误（跳过）</span>"
    +(autoInfCount?" · <span style='color:#9254de'>✨ "+autoInfCount+" 行方向已自动推断</span>":"");

  const fieldCols=cfg.fields.map(f=>"<th style='padding:7px 10px;white-space:nowrap'>"+f.label+"</th>").join("");
  const allSubjs=[...new Set(parsed.flatMap(r=>Object.keys(r.scores)))];
  const subjCols=allSubjs.map(s=>"<th style='padding:7px 10px;white-space:nowrap'>"+s+"</th>").join("");
  const bodyRows=parsed.map(r=>{
    const bg=r.warnings.length?(r.uid?"#fffbe6":"#fff2f0"):"";
    const fieldTds=cfg.fields.map(f=>"<td style='padding:6px 10px'>"+(r.fields[f.id]||"—")+"</td>").join("");
    const dirStyle=r.dirRaw.startsWith("✨")?"color:#9254de;font-size:11px":"";
    const subjTds=allSubjs.map(s=>{
      const v=r.scores[s];
      if(v===undefined) return "<td style='padding:6px 10px;color:#ccc'>-</td>";
      if(v===null) return "<td style='padding:6px 10px;color:var(--red)'>❌</td>";
      return "<td style='padding:6px 10px'>"+v+"</td>";
    }).join("");
    const warnTd=r.warnings.length
      ?"<td style='padding:6px 10px;color:"+(r.uid?"var(--gold)":"var(--red)")+";font-size:11px'>"+r.warnings.join("；")+"</td>"
      :"<td style='padding:6px 10px;color:var(--green);font-size:11px'>✅</td>";
    return "<tr style='background:"+bg+";border-bottom:1px solid #f0f0f0'>"
      +"<td style='padding:6px 10px;color:var(--sub);font-size:11px'>"+r.rowIdx+"</td>"
      +fieldTds+"<td style='padding:6px 10px;"+dirStyle+"'>"+(r.dirRaw||"—")+"</td>"
      +subjTds+warnTd+"</tr>";
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

/* ── 导入执行 ──────────────────────────────────────────────── */

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
