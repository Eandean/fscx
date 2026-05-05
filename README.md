# FSCX · 学业水平评价成绩查询系统

基于 Cloudflare Workers + D1 + KV 构建的轻量级成绩查询平台，无需服务器，全球边缘节点加速，免费额度足以支撑中小规模考试数据。

---

## 目录

1. [项目简介](#1-项目简介)
2. [功能特性](#2-功能特性)
3. [技术架构](#3-技术架构)
4. [文件说明](#4-文件说明)
5. [部署方式一：命令行（Wrangler）](#5-部署方式一命令行wrangler)
6. [部署方式二：Cloudflare 控制台（小白推荐）](#6-部署方式二cloudflare-控制台小白推荐)
7. [后台使用说明](#7-后台使用说明)
8. [安全说明](#8-安全说明)
9. [常见问题](#9-常见问题)

---

## 1. 项目简介

FSCX 是一套面向学校、教育机构的**成绩查询系统**。学生在前台输入准考证号、姓名、学校等信息即可查询本次及历次考试成绩；管理员在后台录入、导入、管理成绩数据并配置系统各项参数。

整个系统只有**一个 JS 文件**，部署在 Cloudflare Workers 上，不需要购买服务器、不需要备案、不需要运维，Cloudflare 免费套餐即可正常运行。

---

## 2. 功能特性

### 前台（学生端）

- 按考试批次选择后查询成绩
- 支持多字段校验（姓名、学校等），防止他人查询
- 显示当次成绩及历次考试成绩对比
- 各科成绩自动计算等次（优秀 / 良好 / 合格 / 待提升）和总分
- 响应式设计，手机、电脑均可正常使用

### 后台（管理员端）

- **成绩管理**：单条录入、批量导入（支持 Excel / CSV / TXT）、编辑、删除、批量删除
- **分页浏览**：可自定义每页显示 20 / 50 / 100 / 200 条或全部显示，支持页码跳转
- **考试批次**：新增、编辑、删除批次，控制是否对前台开放
- **查询字段**：自定义前台查询表单字段，可拖拽排序，设置必填、唯一键、校验字段
- **方向科目**：管理考试方向（历史 / 物理 / 职业等）及各方向科目
- **页面设置**：自定义标题、公告、页脚、帮助说明等文字
- **统计概览**：学生总数、成绩记录数、各批次录入情况
- **记住登录**：可选 7 天免登录，刷新页面自动进入后台
- **安全防护**：Token 认证、IP 速率限制、30 分钟空闲自动登出、XSS 防护

---

## 3. 技术架构

```
浏览器
  │
  ├── GET /          前台查询页
  ├── GET /result    成绩结果页
  ├── GET /help      查询说明页
  ├── GET /admin     后台管理页
  │
  ├── POST /api/pub/config   获取公开配置（批次、字段等）
  ├── POST /api/pub/query    学生查询成绩（有 IP 速率限制）
  │
  ├── POST /api/admin/login  管理员登录（返回 Token）
  ├── POST /api/admin/logout 登出（撤销 Token）
  ├── POST /api/admin/config 读写系统配置（需 Token）
  └── POST /api/admin/score  成绩 CRUD（需 Token）

Cloudflare Workers（fscx-d1.js）
  ├── D1 数据库（fscx-db）
  │     ├── config 表   系统配置（JSON 存储）
  │     └── scores 表   成绩数据
  └── KV 命名空间
        ├── ratelimit:* IP 速率限制计数
        └── admtok:*    管理员登录 Token
```

**选用 Cloudflare 的理由：**

| 资源 | 免费额度 | 说明 |
|------|---------|------|
| Workers 请求 | 10 万次/天 | 足够日常使用 |
| D1 数据库读 | 500 万次/天 | 非常充裕 |
| D1 数据库写 | 10 万次/天 | 导入时消耗较多 |
| KV 读 | 10 万次/天 | 用于限流和 Token |
| KV 写 | 1000 次/天 | 登录和限流写入 |

---

## 4. 文件说明

```
fscx/
├── fscx-d1.js    主程序（Worker 脚本，包含前后台所有逻辑）
├── schema.sql    数据库初始化脚本
└── wrangler.toml 项目配置文件
```

### wrangler.toml 说明

```toml
name = "fscx"                    # Worker 名称（也是访问子域名前缀）
main = "fscx-d1.js"              # 入口脚本
compatibility_date = "2024-01-01"

# 注意：ADMIN_PASSWORD 不写在这里，用 wrangler secret 命令单独设置

[[d1_databases]]
binding       = "DB"
database_name = "fscx-db"       # D1 数据库名称
database_id   = "..."           # 创建数据库后填入

[[kv_namespaces]]
binding = "KV"
id      = "..."                 # 创建 KV 后填入
```

---

## 5. 部署方式一：命令行（Wrangler）

适合有一定命令行基础的用户，操作最灵活，也是后续更新最方便的方式。

### 5.1 前提条件

- 已安装 [Node.js](https://nodejs.org/)（v18 或以上）
- 拥有 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费注册）

### 5.2 安装 Wrangler

打开命令行（Windows 用 CMD 或 PowerShell，Mac 用终端），执行：

```bash
npm install -g wrangler
```

验证安装成功：

```bash
wrangler -v
# 输出类似：⛅️ wrangler 4.x.x
```

### 5.3 登录 Cloudflare

```bash
wrangler login
```

会自动打开浏览器，在 Cloudflare 页面点击「Allow」授权，命令行显示 `Successfully logged in.` 即可。

### 5.4 进入项目目录

将 `fscx-d1.js`、`schema.sql`、`wrangler.toml` 三个文件放在同一个文件夹，然后在命令行进入该文件夹：

```bash
cd C:\Users\你的用户名\Desktop\fscx   # Windows
# 或
cd ~/Desktop/fscx                      # Mac
```

### 5.5 创建 D1 数据库

```bash
wrangler d1 create fscx-db
```

执行后会输出类似内容：

```
✅ Successfully created DB 'fscx-db'
[[d1_databases]]
binding       = "DB"
database_name = "fscx-db"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

将 `database_id` 的值填入 `wrangler.toml` 对应位置。

### 5.6 创建 KV 命名空间

```bash
wrangler kv namespace create KV
```

输出类似：

```
✨ Success!
[[kv_namespaces]]
binding = "KV"
id      = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

将 `id` 的值填入 `wrangler.toml` 对应位置。

### 5.7 初始化数据库表结构

```bash
wrangler d1 execute fscx-db --file=schema.sql --remote
```

出现确认提示时输入 `y` 回车。成功后显示「Executed 4 queries」。

### 5.8 设置管理员密码

```bash
wrangler secret put ADMIN_PASSWORD
```

按提示输入密码（输入时不显示字符，正常现象），回车确认。

> ⚠️ 密码请设置得复杂一些，建议 12 位以上，包含大小写字母、数字和符号。

### 5.9 部署

```bash
wrangler deploy
```

成功后输出访问地址，格式为：

```
https://fscx.你的CF子域.workers.dev
```

**后续更新只需重复此步骤**，数据库内容不受影响。

### 5.10 绑定自定义域名（可选）

如果你有自己的域名并已托管在 Cloudflare：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → 点击 **fscx**
3. 点击 **Settings** → **Domains & Routes** → **Add**
4. 填入你的域名（如 `score.yourdomain.com`），保存

---

## 6. 部署方式二：Cloudflare 控制台（小白推荐）

全程在 Cloudflare 网页操作，不需要安装任何软件，适合完全不熟悉命令行的用户。

> 缺点：每次更新代码需要手动复制粘贴，略繁琐。

### 6.1 注册并登录 Cloudflare

访问 [dash.cloudflare.com](https://dash.cloudflare.com)，注册或登录账号（免费）。

### 6.2 创建 D1 数据库

1. 左侧菜单点击 **Storage & Databases** → **D1 SQL Database**
2. 点击右上角 **Create** 按钮
3. 数据库名称填 `fscx-db`，点击 **Create**
4. 进入数据库详情页，点击顶部 **Console** 标签
5. 将 `schema.sql` 文件的全部内容复制粘贴到输入框，点击 **Execute** 执行
6. 看到「4 commands executed」表示成功
7. 记下页面上的 **Database ID**（后面要用）

### 6.3 创建 KV 命名空间

1. 左侧菜单点击 **Storage & Databases** → **KV**
2. 点击 **Create a namespace**
3. 名称填 `fscx-kv`（随意），点击 **Add**
4. 记下生成的 **Namespace ID**（后面要用）

### 6.4 创建 Worker

1. 左侧菜单点击 **Workers & Pages**
2. 点击 **Create** → **Create Worker**
3. Worker 名称填 `fscx`，点击 **Deploy**（先用默认代码部署，下一步替换）
4. 部署成功后点击 **Edit Code**
5. 将左侧编辑器中的所有内容**全部删除**，然后将 `fscx-d1.js` 的全部内容粘贴进去
6. 点击右上角 **Deploy** 保存

### 6.5 绑定 D1 数据库

1. 回到 Worker 详情页，点击顶部 **Settings**
2. 找到 **Bindings** 部分，点击 **Add**
3. 选择 **D1 database**
4. Variable name 填 `DB`
5. D1 database 选择 `fscx-db`
6. 点击 **Save**

### 6.6 绑定 KV 命名空间

1. 同样在 **Bindings** 中点击 **Add**
2. 选择 **KV Namespace**
3. Variable name 填 `KV`
4. KV Namespace 选择刚才创建的 `fscx-kv`
5. 点击 **Save**

### 6.7 设置管理员密码

1. 同样在 **Settings** 页面，找到 **Variables and Secrets**
2. 点击 **Add**，类型选择 **Secret**（加密存储，不可见）
3. Name 填 `ADMIN_PASSWORD`
4. Value 填你的管理员密码
5. 点击 **Deploy**

### 6.8 重新部署使配置生效

1. 回到 Worker 详情页，点击 **Edit Code**
2. 直接点击右上角 **Deploy**（代码不变，触发一次重新部署让绑定生效）

### 6.9 访问系统

部署完成后，访问地址为：

```
https://fscx.你的CF子域.workers.dev
```

在 Worker 详情页的 **Overview** 标签可以看到完整访问地址。

### 6.10 后续更新代码

1. 进入 Worker → **Edit Code**
2. 全选编辑器内容，粘贴新版 `fscx-d1.js`
3. 点击 **Deploy**

---

## 7. 后台使用说明

后台地址：`https://你的域名/admin`

### 首次使用流程

1. 进入后台，输入部署时设置的管理员密码登录
2. 进入 **考试批次** → 新增批次，填写批次 ID（英文）、显示名称、日期，勾选「对外开放」
3. 进入 **方向科目** → 确认或修改考试方向和科目列表
4. 进入 **查询字段** → 确认前台查询表单字段配置
5. 进入 **批量导入** → 选择批次，上传 Excel 文件导入成绩
6. 进入 **页面设置** → 修改系统标题、公告等文字

### 批量导入格式

Excel 文件第一行为表头，系统会自动识别列映射。推荐的列名：

| 列名 | 说明 |
|------|------|
| 准考证号 | 唯一键，必须有 |
| 姓名 | 校验字段 |
| 学校 | 校验字段 |
| 考试方向 | 填方向名称，如「历史方向」 |
| 语文 | 各科成绩（数字） |
| 数学 | 各科成绩（数字） |
| 英语 | 各科成绩（数字） |
| …… | 其他科目 |

---

## 8. 安全说明

本系统已针对以下安全问题进行加固：

| 问题 | 处理方式 |
|------|---------|
| 管理员密码硬编码 | 改用 Cloudflare Secret，不进入代码和版本控制 |
| 每次请求传输密码 | 改为 Token 认证，登录后签发随机 Token，密码只传一次 |
| XSS 注入 | 所有数据库内容写入 HTML 前进行转义 |
| 暴力破解 | IP 速率限制，连续错误 10 次后锁定 15 分钟 |
| 公开接口枚举 | 前台查询接口同样受 IP 速率限制保护 |
| KV 故障绕过 | KV 不可用时拒绝请求，不静默放行 |
| 会话无限期 | 普通登录 8 小时过期；30 分钟空闲自动登出 |

---

## 9. 常见问题

**Q：部署后访问提示 500 错误？**  
A：通常是 D1 数据库或 KV 没有正确绑定，或 `schema.sql` 未执行。检查 Worker 的 Bindings 配置，确认 `DB` 和 `KV` 均已绑定。

**Q：后台登录提示「密码错误」但密码是对的？**  
A：可能是第一次部署时用了明文 `[vars]` 设置密码，后来又用 `wrangler secret` 设置了 Secret，两者冲突。去 Dashboard → Worker → Settings → Variables and Secrets，删除 `ADMIN_PASSWORD` 变量，只保留 Secret 版本，重新部署即可。

**Q：导入 Excel 时失败？**  
A：确认文件格式为 `.xlsx`，第一行必须有表头，准考证号列不能为空。文件过大时（几千行以上）可分批导入。

**Q：想修改每页默认显示数量？**  
A：在后台「成绩查看」页面右上角的下拉菜单中选择，可选 20 / 50 / 100 / 200 条或全部显示。

**Q：如何修改管理员密码？**  
A：命令行执行 `wrangler secret put ADMIN_PASSWORD` 重新设置，然后 `wrangler deploy`。控制台操作：Settings → Variables and Secrets → 找到 `ADMIN_PASSWORD` → 编辑 → 重新部署。

**Q：免费额度会超吗？**  
A：对于学校考试场景（几千到几万学生，查询集中在放榜后几天），免费额度完全足够。如果担心，可在 Cloudflare Dashboard 查看实时用量。
