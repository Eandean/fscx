# fscx-server 零基础部署手册

> 把你电脑上的成绩查询系统变成全世界都能访问的网站。
>
> 本文面向**没有任何服务器经验**的用户，所有步骤都解释了"为什么这样做"和"还有没有其他选择"。

---

# 第一章：你要做的事情，以及背后的原理

## 1.1 你在干什么？

你现在有一个项目文件夹 `fscx-server/`，里面有一套成绩查询系统的代码。它现在只能在**你自己的电脑上**运行，只有你能访问 `http://localhost:3000`。

你想让它变成这样：

```
学生在北京用手机 → 输入 https://cjcx.nidexuexiao.com → 看到成绩查询页面
老师在广州用电脑 → 输入同一个网址 → 登录教师工作台
你在家躺着 → 登录管理后台录入成绩
```

要实现这个目标，你需要做三件事：

```
┌─────────────────────────────────────────────────────────────────┐
│ ① 找一台永不关机的电脑（VPS）                                    │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ 你本机 → 可能关机、可能换网络、IP 会变 → 不适合做服务器    │ │
│    │ VPS → 放在数据中心，24小时开机，固定公网IP → 适合做服务器   │ │
│    └─────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ② 在这台电脑上运行你的 Node.js 应用                              │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ 你的代码是 Node.js 写的 → 服务器需要装 Node.js 来运行它    │ │
│    │ 需要让它一直运行 → 用 PM2 管理进程                          │ │
│    │ 需要从外面能访问 → 用 Nginx 做反向代理                      │ │
│    └─────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ③ 告诉全世界你的网站在哪里（DNS + HTTPS）                        │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ 域名 → 人类好记的名字（cjcx.nidexuexiao.com）             │ │
│    │ DNS  → 把域名翻译成服务器 IP 的"电话簿"                   │ │
│    │ HTTPS → 给通信内容加密，防止别人偷看                       │ │
│    └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## 1.2 你需要的全部东西

| 需要的东西 | 为什么需要它 | 有没有免费/更便宜的替代 |
|-----------|-------------|----------------------|
| **一台 VPS** | 你的系统需要一台 24 小时开机的电脑来跑 | ✅ 甲骨文云有永久免费实例（ARM 4核24G）<br>✅ 阿里云腾讯云有学生优惠（10元/月）<br>✅ 也可以用家里的旧电脑开内网穿透 |
| **一个域名** | 用户不需要记 IP 地址，只需要记一个好记的名字 | ✅ 顶级域名最低 30元/年（约 2.5元/月）<br>✅ 可以用某些提供免费域名的服务商（如 `.tk` 域名），但不稳定 |
| **一点点时间** | 第一次配置需要学习 | 没办法省，但以后就一劳永逸了 |

### 💡 建议：如果你预算有限

```
最省钱方案（约 0元/月）：
  甲骨文云免费实例 + 一个便宜的域名（30元/年）
  
最省心方案（约 40元/月）：
  阿里云轻量应用服务器 + 域名
  
最不折腾方案（约 50元/月）：
  Vultr/DigitalOcean + 域名 + Cloudflare DNS
```

---

## 1.3 用户访问你的网站时发生了什么？

理解这个流程，以后出了问题你自己就能排查。假设最终部署完成，一个学生访问 `https://cjcx.nidexuexiao.com`：

```
步骤 ① 浏览器询问 DNS："cjcx.nidexuexiao.com 的 IP 是多少？"
      ↓
步骤 ② DNS 回答："这台服务器的 IP 是 123.123.123.123"
      ↓
步骤 ③ 浏览器连接到 123.123.123.123:443（HTTPS 默认端口）
      ↓
步骤 ④ Nginx（在服务器上监听 443 端口）收到请求
      ↓
步骤 ⑤ Nginx 查看域名 → 匹配到 fscx 配置 → 转发给 localhost:3000
      ↓
步骤 ⑥ Node.js（在 3000 端口监听）处理请求
      ↓
步骤 ⑦ Node.js 查询 SQLite 数据库，生成 HTML 页面
      ↓
步骤 ⑧ HTML 原路返回：Node.js → Nginx → 互联网 → 学生的浏览器
      ↓
步骤 ⑨ 学生看到成绩查询页面
```

### 💡 为什么要经过 Nginx 这一层？

直接访问 `http://localhost:3000` 不行吗？理论上可以，但：

| 场景 | 直接暴露 Node.js 端口 | 用 Nginx 反代 |
|------|---------------------|--------------|
| HTTPS 证书 | Node.js 配置 HTTPS 很麻烦 | Nginx 一行配置搞定 |
| 静态文件 | Node.js 处理效率一般 | Nginx 处理静态文件比 Node.js 快 10 倍以上 |
| 同一台服务器跑多个网站 | 需要不同端口，用户要记端口号 | Nginx 根据域名自动分发 |
| 安全防护 | Node.js 直接暴露容易被攻击 | Nginx 可以挡住很多攻击 |
| 负载均衡 | Node.js 单进程 | Nginx 可以转发到多个 Node.js 进程 |

**总结：Nginx 是专业的"迎宾员"，Node.js 是专业的"业务处理员"，各司其职。**

---

# 第二章：如何选择 VPS（云服务器）

## 2.1 什么是 VPS？

VPS（Virtual Private Server，虚拟专用服务器）是一台**物理服务器通过虚拟化技术分割成的多个虚拟服务器**。

通俗理解：
- 数据中心里有一台强大的物理服务器（比如 64 核 CPU、512GB 内存）
- 通过虚拟化技术（KVM、Xen、VMware）把它分成很多个"小服务器"
- 每个"小服务器"就是一个 VPS，有自己的 CPU、内存、硬盘、IP 地址
- 你租用其中一个，拥有 root 权限，想装什么系统就装什么

**你的 VPS 就是你的成绩查询系统的家——它 24 小时住在那里。**

## 2.2 主流 VPS 服务商对比

### 国内服务商

#### 阿里云

| 项目 | 说明 |
|------|------|
| **适合人群** | 新手、国内用户、需要备案 |
| **最低配置** | 轻量应用服务器：2核1G 40GB SSD |
| **价格** | 新用户首年约 30元/月，续费约 50元/月 |
| **学生优惠** | 「云翼计划」：认证学生后 10元/月 |
| **优点** | 国内访问速度最快，售后好，文档中文 |
| **缺点** | 必须实名+备案（1-3周），续费贵 |
| **购买链接** | https://swas.aliyun.com |

#### 腾讯云

| 项目 | 说明 |
|------|------|
| **适合人群** | 国内用户、学生 |
| **最低配置** | 轻量应用服务器：2核2G 40GB SSD |
| **价格** | 新用户首年约 30元/月 |
| **学生优惠** | 「云+校园」：认证学生后 10元/月 |
| **优点** | 同阿里云，偶尔比阿里云便宜 |
| **缺点** | 同样需要实名+备案 |

### 国外服务商

#### 搬瓦工 (BandwagonHOST)

| 项目 | 说明 |
|------|------|
| **适合人群** | 不想备案的用户、需要国外线路 |
| **最低配置** | 1核512M 10GB SSD |
| **价格** | 约 50元/月（CN2 GIA 线路） |
| **优点** | 免实名免备案，CN2 GIA 线路国内访问很快 |
| **缺点** | 库存少（经常断货），比国内贵 |
| **购买** | https://bwh81.net（需要抢购） |

#### Vultr

| 项目 | 说明 |
|------|------|
| **适合人群** | 开发者、短期使用、测试 |
| **最低配置** | 1核512M 10GB SSD |
| **价格** | $6/月（约 43元） |
| **优点** | 按小时计费（随时创建/销毁），全球 20+ 数据中心 |
| **缺点** | 国内访问速度一般，需要自己优化线路 |
| **购买** | https://www.vultr.com |

#### DigitalOcean

| 项目 | 说明 |
|------|------|
| **适合人群** | 开发者、文档党 |
| **最低配置** | 1核512M 10GB SSD |
| **价格** | $6/月（约 43元） |
| **优点** | 文档非常详细，控制面板好用 |
| **缺点** | 同 Vultr，国内访问速度一般 |
| **购买** | https://www.digitalocean.com |

#### 甲骨文云 (Oracle Cloud)

| 项目 | 说明 |
|------|------|
| **适合人群** | 想白嫖的用户 |
| **最低配置** | **永久免费**：ARM 4核24G 200GB（限 2 台） |
| **价格** | **0元/月**（只要不超额度） |
| **优点** | 免费！配置慷慨！ |
| **缺点** | 注册审核严格（有时需要国际信用卡），ARM 架构兼容性略差（但 Node.js 完全没问题） |
| **购买** | https://cloud.oracle.com |

### 💡 建议：我该怎么选？

| 你的情况 | 推荐方案 |
|---------|---------|
| 你是学生，有学生证 | 阿里云/腾讯云学生机（10元/月）|
| 你是学生，没钱 | 甲骨文云免费实例（0元/月） |
| 不想备案（怕麻烦） | 搬瓦工 CN2 GIA 或 Vultr |
| 只想先试试 | Vultr 按小时计费（随时销毁，花不了几块钱）|
| 国内访问速度要求高 | 阿里云/腾讯云 |
| 既要免费又要国内访问快 | 不太可能，免费的一般在国外|

> ⚠️ **重要提醒**：选择国内服务器（阿里云/腾讯云/华为云）时，域名**必须备案**才能使用 80/443 端口。备案流程：
> 1. 在服务商平台提交备案申请
> 2. 服务商初审（1-2 个工作日）
> 3. 提交到管局审核（5-20 个工作日）
> 4. 审核通过后获得备案号
>
> 如果不想备案，买国外服务器（搬瓦工/Vultr/DigitalOcean/甲骨文），不需要备案。

## 2.3 如何购买 VPS（以阿里云轻量应用服务器为例）

### 步骤 1：注册账号

1. 打开 https://www.aliyun.com
2. 点击右上角「免费注册」
3. 手机号注册 → 设置密码 → 登录
4. 点击右上角头像 → 「实名认证」
5. 选择「个人认证」→ 输入姓名 + 身份证号 → 人脸识别

### 步骤 2：进入轻量应用服务器控制台

1. 打开 https://swas.aliyun.com
2. 点击「创建实例」

### 步骤 3：选择配置

在创建页面，你会看到很多配置项。下面是每个选项的详细解释：

```
① 地域
   什么是：服务器放在哪个城市的机房
   怎么选：选离你用户最近的。如果你学校在广州，选「华南1（广州）」；
           如果你学校在北京，选「华北2（北京）」
   为什么：距离越近，网络延迟越低（从 50ms 降到 5ms）

② 镜像
   什么是：服务器装什么操作系统
   怎么选：选择「系统镜像」→「Ubuntu 22.04」（或 24.04）
   为什么：Ubuntu 是 Linux 中最适合新手的发行版，命令和网上教程最匹配
           CentOS 已停止维护，不要选

③ 套餐规格
   什么是：服务器给多少 CPU、内存、硬盘
   怎么选：最低套餐就行（2核1GB，40GB SSD）
   够不够：完全够。你的成绩查询系统只需要约 200MB 内存，CPU 占用通常 < 5%
   
④ 数据盘
   什么是：额外的硬盘空间
   怎么选：不需要。40GB 系统盘足够装 Ubuntu + Node.js + 你的代码 + 数据库
   
⑤ 购买时长
   怎么选：先买 1 个月试试，后续可以手动续费
```

### 步骤 4：设置密码

1. 创建完成后，在实例列表中找到你的服务器
2. 点击「更多」→「重置密码」
3. 设置密码规则：
   - **至少 16 位**
   - **包含大写字母、小写字母、数字、特殊符号**
   - **不要和任何其他账号密码相同**
   - 例如：`Fscx@2025!Server#Secure`
4. 点击「确定」→ 等待重启完成（约 1-2 分钟）

### 步骤 5：开放防火墙端口

阿里云的轻量应用服务器有内置防火墙，默认只开放了 22 端口（SSH）。你需要开放 80 和 443 端口给别人访问你的网站。

1. 在实例详情页，点击「防火墙」标签
2. 点击「添加规则」
3. 添加以下三条规则：

```
第一次添加：
  协议：     TCP
  端口：     80
  授权对象： 0.0.0.0/0
  备注：     HTTP 网页访问
  
第二次添加：
  协议：     TCP
  端口：     443
  授权对象： 0.0.0.0/0
  备注：     HTTPS 加密访问
  
第三次添加（可选，但推荐）：
  协议：     TCP
  端口：     22
  授权对象： 你的家庭宽带 IP（或学校 IP）/32
  备注：     仅允许你自己 SSH 登录
```

> 💡 `0.0.0.0/0` 表示"所有人"。
> 💡 把 SSH 端口限制为你的 IP 可以防止别人暴力破解你的 SSH 密码。
> 如果你的 IP 是动态的（重启路由器会变），就保留为 `0.0.0.0/0`。

---

# 第三章：域名——你的网站在互联网上的名字

## 3.1 什么是域名？为什么需要域名？

**没有域名的情况：**
```
学生要访问你的网站，需要记住 IP 地址：http://123.123.123.123/
- 记不住（一串数字）
- IP 变了就找不到了
- 看起来不专业
```

**有域名的情况：**
```
学生访问：https://cjcx.nidexuexiao.com/
- 好记（学校的缩写 + 成绩查询）
- IP 变了修改 DNS 记录就行，用户无感知
- 显示小锁图标，看起来正式可靠
```

### DNS 的工作原理（了解这个有助于排查问题）

DNS（Domain Name System，域名系统）是互联网的"电话簿"：

```
你查"张三的电话" → 电话簿告诉你 138xxxxxxx
你查"cjcx.nidexuexiao.com" → DNS 告诉你 123.123.123.123
```

当你输入 `cjcx.nidexuexiao.com` 时，背后发生的是：

```
┌──────────┐  ① 查询    ┌─────────────┐
│ 浏览器    │ ──────→    │ 本地 DNS 缓存 │
│          │             │（电脑/路由器）│
│          │ ←──────     │              │
│          │  有缓存则返回              │
│          │             └─────────────┘
│          │  ② 无缓存   ┌─────────────┐
│          │ ──────→    │ 递归 DNS 服务器 │
│          │            │（电信/联通/    │
│          │            │ Cloudflare/   │
│          │            │ 阿里云 DNS）    │
│          │            └──────┬──────┘
│          │                   │ ③ 问根域名服务器
│          │                   │ ".com 的 NS 是？"
│          │                   │ ④ 问顶级域名服务器
│          │                   │ "nidexuexiao.com 的 NS 是？"
│          │                   │ ⑤ 问权威 DNS 服务器
│          │                   │ "cjcx.nidexuexiao.com 的 A 记录是？"
│          │                   │ ⑥ 返回 IP 地址
│          │ ←─────────────────┘
│          │  ⑦ 拿到 IP：123.123.123.123
│          │
│          │  ⑧ 连接 123.123.123.123:443
└──────────┘
```

这个过程的任何一个环节出错，用户就无法访问你的网站。最常见的错误是：
- 域名没有添加 A 记录 → DNS 返回 "NXDOMAIN"（域名不存在）
- A 记录指向了错误的 IP → 连接超时或连到别人的服务器
- DNS 缓存没更新 → 你改了记录，但用户还在用旧 IP

## 3.2 如何选择域名

### 域名结构

```
cjcx . nidexuexiao . com
  ↕         ↕           ↕
子域名     主域名    顶级域
```

你可以自定义的部分是**主域名**（`nidexuexiao`）和**子域名**（`cjcx`）。

### 命名建议

| 建议 | 例子 | 说明 |
|------|------|------|
| 用学校名称缩写 | `nidexuexiao.com` | 跟你学校相关，好记 |
| 用成绩查询缩写做子域名 | `cjcx.nidexuexiao.com` | 看到就知道是查成绩的 |
| 避免侵权 | 不要用 `tsinghua`、`peking` | 知名大学名称受保护 |
| 避免长域名 | 不要超过 15 个字母 | 越长越难打 |
| 选择常见顶级域 | `.com` > `.cn` > `.net` > `.org` | `.com` 最通用 |

### 域名购买渠道对比

| 服务商 | 价格（.com） | 特点 | 适合人群 |
|--------|-------------|------|---------|
| **Namesilo** | 约 $8.90/年（约 65元） | 国外最便宜，免费隐私保护 | 不备案用户 |
| **Cloudflare Registrar** | 成本价约 $8.60/年 | 不加价，只收注册局费用 | Cloudflare 用户 |
| **阿里云/万网** | 首年约 30-50元，续费约 70元 | 国内方便，跟服务器同一平台 | 国内用户 |
| **腾讯云/DNSPod** | 同阿里云 | 经常有优惠券 | 国内用户 |
| **GoDaddy** | 首年很便宜（$1-2），续费很贵 | 营销套路多，不推荐新手 | ❌ 不推荐 |
| **免费域名（.tk等）** | 0元 | 不稳定，随时可能被收回 | ❌ 不推荐 |

> 💡 **强烈建议**：域名不要省这点钱。一个 `.com` 域名一年 30-70 元，平均一天不到 2 毛钱。免费域名不稳定，如果被收回，你的用户就再也访问不了了。

### 购买的注意事项

```
✅ 购买时先买 1 年，之后按年续费
✅ 开启"自动续费"（忘了续费域名会被别人抢走）
✅ 开启"隐私保护"（防止别人查到你的个人信息）
❌ 不要买太长年限（不确定这个域名是否一直用）
```

## 3.3 配置 DNS 解析

### 3.3.1 什么是 DNS 解析？

DNS 解析就是**在域名和服务器 IP 之间建立映射关系**。你在域名管理后台添加一条 A 记录，告诉全世界：
```
"cjcx.nidexuexiao.com → 123.123.123.123"
```

### 3.3.2 在哪里配置 DNS？

你买的域名在哪家注册，就在哪家管理 DNS。但**你也可以把 DNS 托管到其他服务商**。

| DNS 托管商 | 特点 |
|-----------|------|
| **域名注册商自带** | 默认，最简单 |
| **Cloudflare DNS** | 免费、快、额外安全保护，**强烈推荐** |
| **阿里云 DNS** | 国内解析快，跟阿里云服务器配合好 |
| **DNSPod（腾讯云）** | 国内老牌 DNS 服务商 |

### 3.3.3 配置步骤

**情况 A：域名在阿里云买，DNS 也在阿里云（最简单）**

1. 登录阿里云控制台
2. 进入「域名管理」（https://dc.aliyun.com）
3. 点击你的域名
4. 点击「DNS 解析」→「添加记录」

```
记录类型： A        （把域名指向 IPv4 地址）
主机记录： cjcx     （子域名，最终域名 cjcx.nidexuexiao.com）
记录值：   123.123.123.123（你的服务器公网 IP，替换成真实的）
TTL：     600       （10分钟，单位秒）
```

5. 点击「确认」

**情况 B：使用 Cloudflare DNS**

Cloudflare DNS 的好处：
- 全球加速（Anycast 技术，用户自动连接到最近的节点）
- DDoS 防护（防止别人攻击你的网站）
- 免费 SSL 证书（不需要 certbot）
- 隐藏服务器真实 IP（安全）

步骤：

1. 注册 Cloudflare 账号（https://dash.cloudflare.com/sign-up）
2. 添加你的域名（输入 `nidexuexiao.com`）
3. Cloudflare 会自动扫描你现有的 DNS 记录
4. 确认或手动添加 A 记录：

```
Type:   A
Name:   cjcx
IPv4:  你的服务器 IP
Proxy status:  DNS Only（先选灰色云朵，后面可以改 Proxied）
TTL:   Auto
```

5. Cloudflare 会给你两个 NS 服务器地址（类似 `dora.ns.cloudflare.com`）
6. **关键步骤**：去你的域名注册商那里，把 NS 服务器改为 Cloudflare 的
   - 在阿里云域名管理 → DNS 修改 → 改为自定义 DNS
   - 填入 Cloudflare 给你的两个 NS 地址
   - 保存
7. 回到 Cloudflare，点击「Done, check nameservers」
8. 等待 NS 变更生效（通常几分钟到几小时）

### 3.3.4 等待 DNS 生效

DNS 修改不是立即生效的，有一个**传播时间**：

| 情况 | 预计生效时间 |
|------|------------|
| TTL 设为 600（10分钟） | 约 10-30 分钟 |
| 修改 NS 服务器 | 约 1-48 小时（取决于注册商）|
| 新增 A 记录 | 约 5-30 分钟 |

**验证 DNS 是否生效：**

在你的 WSL 中执行：

```bash
# 方法 1：nslookup（推荐）
nslookup cjcx.nidexuexiao.com

# 方法 2：dig（如果装了 dig）
dig cjcx.nidexuexiao.com +short

# 方法 3：ping
ping cjcx.nidexuexiao.com

# 方法 4：在线工具
# 访问 https://dnschecker.org 输入你的域名，查看全球 DNS 解析结果
```

如果返回的 IP 是你的服务器 IP，说明 DNS 解析成功了。

---

# 第四章：SSH —— 如何远程控制你的服务器

## 4.1 什么是 SSH？

SSH（Secure Shell，安全外壳协议）是一种**加密的网络协议**，让你可以安全地远程登录服务器执行命令。

### 通俗理解

```
你的 WSL (Ubuntu)  ─── 加密隧道 ───→ 服务器 (Ubuntu)
     ↓                                        ↓
 你输入命令                                服务器执行命令
 你看到结果                                返回结果给你

就相当于你坐在服务器面前操作它，只不过是通过网络。
```

### SSH 和 telnet 的区别

| 对比 | SSH | Telnet（旧协议） |
|------|-----|-----------------|
| 加密 | ✅ 所有数据加密传输 | ❌ 明文传输（包括密码） |
| 安全 | ✅ 防窃听、防篡改 | ❌ 任何人可以抓包看到你的密码 |
| 端口 | 22 | 23 |

**所以：永远用 SSH，不要用 Telnet。**

## 4.2 第一次 SSH 登录

### 在你本机的 WSL 中执行

```bash
ssh root@你的服务器IP
```

比如你的服务器 IP 是 `123.123.123.123`：

```bash
ssh root@123.123.123.123
```

### 第一次连接会发生什么

```
The authenticity of host '123.123.123.123 (123.123.123.123)' can't be established.
ED25519 key fingerprint is SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.
This host key is not known by the user.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

**这是什么意思？**

你的电脑在说："我不认识这台服务器，它的指纹是 xxxxx。你确定要连接吗？"

这是 SSH 的安全机制——防止"中间人攻击"（有人冒充服务器拦截你的连接）。

**你该怎么做？**

输入 `yes`，回车。第一次只需要这样，以后就不会再问了。

### 输入密码

```
root@123.123.123.123's password:
```

**⚠️ 重要：你输入密码时屏幕不会显示任何字符（没有星号，没有光标移动），这是正常的！**

输入完密码按回车。每次按一个键，你都不会看到反馈，但系统确实接收到了。

### 登录成功

如果密码正确，你会看到类似：

```
Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)

 * Documentation:  https://help.ubuntu.com
 * Management:     https://landscape.canonical.com
 * Support:        https://ubuntu.com/advantage

  System information as of Mon Jan 15 10:30:00 CST 2025

  System load:  0.0              Processes:             120
  Usage of /:   8.2% of 39.12GB  Users logged in:       1
  Memory usage: 15%              IPv4 address for eth0: 123.123.123.123
  ...

Last login: Mon Jan 15 10:25:00 2025 from x.x.x.x
root@iZj6cxxxxxxxx:~#
```

这个 `root@iZj6cxxxxxxxx:~#` 就是你的命令提示符，意思：
- `root`：当前登录的用户名
- `iZj6cxxxxxxxx`：服务器的主机名
- `~`：当前目录（`~` 表示 `/root`，即 root 用户的家目录）
- `#`：表示你是 root 用户（普通用户是 `$`）

### 退出 SSH

```bash
exit
# 或按 Ctrl + D
```

## 4.3 SSH 免密登录（强烈推荐）

### 为什么要配免密登录？

```
每次 SSH 都要输密码 → 麻烦、密码容易被偷看
免密登录 → 一键连接、更安全
```

### SSH 密钥对的工作原理

```
你的电脑（客户端）                    服务器
┌────────────┐                    ┌────────────┐
│ 私钥       │ ←── 永远藏好 ──→   │            │
│ (id_ed25519)│                    │            │
│            │                    │  公钥       │
│ 用私钥签名  │ ──── 验证请求 ──→  │ (authorized  │
│ 一条消息    │                    │  _keys)     │
│            │ ←── 验证通过 ────   │  可以解密   │
└────────────┘                    └────────────┘
```

### 配置步骤

**在你的 WSL 中执行（不是 SSH 到服务器之后）：**

```bash
# 第一步：生成密钥对（如果还没有的话）
# 一次生成，永久使用。如果你之前生成过，跳过这一步。
ssh-keygen -t ed25519 -C "fscx-server"
```

执行后：

```
Generating public/private ed25519 key pair.
Enter file in which to save the key (/home/你的用户名/.ssh/id_ed25519):
```

按回车（接受默认路径）。

```
Enter passphrase (empty for no passphrase):
```

**关键选择**：要不要给私钥加密码？
- 不加密码：更方便，但私钥泄露别人就能登录你的服务器
- 加密码：更安全，但每次 SSH 要输密码（相当于把密码换成了另一个密码）

建议：**不加密码**（如果你的电脑只有你用），或者**加一个简单密码**（防君子不防小人）。

直接按回车（不设密码），再按一次确认。

```
Your identification has been saved in /home/你的用户名/.ssh/id_ed25519
Your public key has been saved in /home/你的用户名/.ssh/id_ed25519.pub
The key fingerprint is:
SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx fscx-server
```

**第二步：把公钥传到服务器**

```bash
ssh-copy-id root@你的服务器IP
```

输入一次密码。之后 `ssh root@你的服务器IP` 就不需要密码了。

**背后的原理：**

`ssh-copy-id` 实际上做了三件事：
1. 读取你的公钥（`~/.ssh/id_ed25519.pub`）
2. SSH 登录服务器
3. 在服务器的 `~/.ssh/authorized_keys` 文件中添加你的公钥

以后每次 SSH，服务器会用这个公钥验证你的私钥，验证通过就允许登录，不再问密码。

### 如果 ssh-copy-id 不可用（Windows 某些终端）

手动复制：

```bash
# 在你的 WSL 中
cat ~/.ssh/id_ed25519.pub
# 复制输出的内容

# SSH 到服务器
ssh root@你的服务器IP
mkdir -p ~/.ssh
echo "刚才复制的内容" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh
exit

# 现在再 SSH 就不需要密码了
ssh root@你的服务器IP
```

## 4.4 常见的 SSH 问题

### 问题：Connection refused（连接被拒绝）

```
ssh: connect to host 123.123.123.123 port 22: Connection refused
```

原因 | 解决方法
-----|---------
SSH 服务没装/没启动 | 在云控制台通过 VNC 连接，装 openssh-server
防火墙没开放 22 端口 | 在云控制台安全组开放 22 端口
IP 地址写错了 | 确认 IP 地址

### 问题：Connection timed out（连接超时）

```
ssh: connect to host 123.123.123.123 port 22: Connection timed out
```

原因 | 解决方法
-----|---------
服务器关机 | 在云控制台启动服务器
网络不通 | ping 你的服务器 IP，如果不通说明网络有问题
防火墙拦截 | 确认安全组开放了 22 端口

### 问题：Permission denied（密码错误）

```
Permission denied, please try again.
```

原因 | 解决方法
-----|---------
密码输错了 | 在云控制台重置密码
键盘布局不同 | 密码中的特殊字符可能输错了（中文输入法下输入的符号不同）
账号名不对 | 确认是 `root` 不是其他用户名

---

# 第五章：服务器初始化

## 5.1 更新软件包

### 为什么需要更新？

刚买的服务器，系统里的软件包版本可能比较旧。更新可以获得：
- 最新的安全补丁
- 更好的稳定性
- 更新的功能

### 执行命令

SSH 登录服务器后：

```bash
# 更新软件包列表（从软件源获取最新包信息）
apt update
```

输出类似：

```
Hit:1 http://mirrors.cloud.aliyuncs.com/ubuntu jammy InRelease
Get:2 http://mirrors.cloud.aliyuncs.com/ubuntu jammy-updates InRelease [119 kB]
...
Fetched 25.2 MB in 3s (8.4 MB/s)
Reading package lists... Done
```

```bash
# 升级所有已安装的软件包
apt upgrade -y
```

`-y` 表示自动回答 "yes"，不需要你手动确认。

### apt 是什么？

- `apt` = Advanced Package Tool（高级包管理工具）
- 它是 Ubuntu/Debian 的软件包管理器
- 相当于手机上的「应用商店」
- 你只需要说"我要装什么"，它自动下载、安装、配置依赖

### 输出里的 "jammy" 是什么意思？

- `jammy` 是 Ubuntu 22.04 的代号
- 每个 Ubuntu 版本都有个字母序的动物代号：
  - 20.04 → Focal Fossa
  - 22.04 → Jammy Jellyfish
  - 24.04 → Noble Numbat

## 5.2 安装常用工具

```bash
apt install -y curl wget git vim htop nginx certbot python3-certbot-nginx
```

**每个工具是干什么的？**

| 工具 | 作用 | 为什么需要 |
|------|------|----------|
| `curl` | 命令行浏览器（发送 HTTP 请求） | 测试 API、下载文件 |
| `wget` | 下载工具 | 下载在线文件 |
| `git` | 版本控制 | 从 GitHub 拉取代码 |
| `vim` | 文本编辑器 | 编辑配置文件 |
| `htop` | 进程管理器（可视化版 top） | 监控服务器资源 |
| `nginx` | Web 服务器/反向代理 | **核心组件**，负责处理用户请求 |
| `certbot` | 自动申请 HTTPS 证书工具 | 给你的网站加上小锁 |
| `python3-certbot-nginx` | certbot 的 Nginx 插件 | 让 certbot 自动修改 Nginx 配置 |

### 💡 关于 vim 的提醒

如果你没用过 vim，这里简单说一下：

```
进入 vim：  vim 文件名
编辑模式：  按 i（左下角显示 -- INSERT--）
保存退出：  按 Esc → 输入 :wq → 回车
不保存退出：按 Esc → 输入 :q! → 回车
```

如果 vim 实在用不惯，可以用 nano（更简单）：

```bash
nano 文件名
# Ctrl+O 保存
# Ctrl+X 退出
```

## 5.3 设置时区

```bash
# 查看当前时区
timedatectl

# 列出所有时区
timedatectl list-timezones | grep -i beijing
# 或
timedatectl list-timezones | grep -i shanghai

# 设置时区为北京/上海时间
timedatectl set-timezone Asia/Shanghai

# 验证
timedatectl
```

**为什么需要设置时区？**

你的成绩查询系统的日志、数据库的时间戳都会使用服务器的系统时间。如果服务器时区是 UTC（英国时间），你看到的时间会差 8 个小时，排查问题时非常困惑。

## 5.4 设置主机名

```bash
# 查看当前主机名
hostname

# 设置为有意义的名称
hostnamectl set-hostname fscx-server
```

主机名只在服务器内部可见，不影响用户访问。设置一个好记的名字方便你以后管理多台服务器。

---

# 第六章：上传项目文件到服务器

## 6.1 确认你的项目文件

先在你的 WSL 中确认项目存在：

```bash
ls -la /mnt/c/Users/11232/Downloads/xiangmu/fscx-server/
```

应该看到类似：

```
total 44
drwxr-xr-x  6 user user  4096 Jan ...
-rw-r--r--  1 user user   540 Jan ...  .env.example
-rw-r--r--  1 user user   413 Jan ...  package.json
drwxr-xr-x  2 user user  4096 Jan ...  src/
-rw-r--r--  1 user user  1020 Jan ...  schema.sql
...
```

## 6.2 方法一：使用 scp 上传（推荐）

### scp 是什么？

- SCP = Secure Copy Protocol（安全复制协议）
- 基于 SSH 加密传输文件
- 相当于"网络上的 cp 命令"

### 执行上传

**在你自己电脑的 WSL（不是 SSH 到服务器）执行：**

```bash
scp -r /mnt/c/Users/11232/Downloads/xiangmu/fscx-server/ root@你的服务器IP:/opt/fscx
```

分解这个命令：

| 部分 | 含义 |
|------|------|
| `scp` | 复制命令 |
| `-r` | 递归复制（复制整个目录） |
| `/mnt/c/.../fscx-server/` | **源路径**（你本机的项目文件夹） |
| `root@你的服务器IP` | **目标服务器** |
| `:/opt/fscx` | **目标路径**（在服务器上的存放位置） |

### 为什么放在 /opt 下？

Linux 的文件系统层次结构（FHS 标准）：

| 目录 | 用途 |
|------|------|
| `/` | 系统根目录，不要乱放 |
| `/home` | 普通用户的家目录 |
| `/root` | root 用户的家目录 |
| `/etc` | 配置文件 |
| `/var` | 变化的数据（日志、数据库等） |
| `/opt` | **可选的应用软件**，适合放自己装的程序 |
| `/usr` | 系统安装的软件 |
| `/tmp` | 临时文件（重启会清空） |

**所以 `/opt/fscx` 是放置成绩查询系统最合适的地方。**

### 上传可能需要输入密码

```
root@你的服务器IP's password:
```

输入密码（如果你配了 SSH 免密登录就不会问）。

传输完成后验证：

```bash
ssh root@你的服务器IP "ls -la /opt/fscx/"
```

## 6.3 方法二：使用 rsync（增量传输）

### rsync 和 scp 的区别

| 对比 | scp | rsync |
|------|-----|-------|
| 传输方式 | 每次都完整复制 | 只传变化的部分 |
| 速度 | 大文件多次传输慢 | 增量传输很快 |
| 使用场景 | 第一次上传 | 后续更新文件 |

### 安装 rsync

```bash
# Windows WSL 一般自带 rsync，如果没有：
sudo apt install rsync
```

### 使用 rsync

```bash
rsync -avz --delete /mnt/c/Users/11232/Downloads/xiangmu/fscx-server/ root@你的服务器IP:/opt/fscx
```

参数解释：

| 参数 | 含义 |
|------|------|
| `-a` | 归档模式（保留权限、时间戳等） |
| `-v` | 显示详细信息 |
| `-z` | 传输时压缩（加快速度） |
| `--delete` | 删除目标端多余的文件（保持两边完全一致） |

### 后续更新代码只需执行

```bash
# 在本地修改代码后
rsync -avz --delete /mnt/c/Users/11232/Downloads/xiangmu/fscx-server/ root@你的服务器IP:/opt/fscx

# 然后 SSH 到服务器重启应用
ssh root@你的服务器IP "pm2 restart fscx"
```

## 6.4 方法三：在服务器上直接使用 Git（如果你会 Git 的话）

```bash
# SSH 登录服务器后
cd /opt
git clone https://github.com/Eandean/fscx.git fscx
```

**注意**：这个方法克隆的是原始的 CF Workers 版本，不是改造后的独立服务器版。如果你把改造版也推到了自己的 GitHub 仓库，可以用这种方式。

### 💡 建议

| 情况 | 推荐方式 |
|------|---------|
| 第一次部署 | scp（简单直接） |
| 后续频繁更新代码 | rsync（增量传输快） |
| 会 Git，代码有仓库 | Git clone + pull |

---

# 第七章：在服务器上安装依赖并配置

## 7.1 安装 Node.js

### 什么是 Node.js？

Node.js 是一个**JavaScript 运行环境**。它让 JavaScript 不只在浏览器里运行，还能在服务器上运行。

```
传统：JavaScript 只能在浏览器里运行（前端）
Node.js：JavaScript 也能在服务器上运行（后端）

你的 fscx 应用就是用 JavaScript 写的后端程序，所以服务器必须安装 Node.js。
```

### 为什么需要特定版本？

你的 `package.json` 里写的依赖 `better-sqlite3` 需要 Node.js 18+。20 LTS 是目前最稳定的版本，推荐使用。

### 安装方法（二选一）

**方法 A：通过 NodeSource 官方源安装（推荐）**

```bash
# 下载 NodeSource 的安装脚本
curl -fsSL https://deb.nodesource.com/setup_20.x -o nodesource_setup.sh

# 这行命令做了什么？
# curl：发送 HTTP 请求获取文件
# -fsSL：静默模式 + 跟随重定向
# -o：保存到文件
# nodesource_setup.sh：NodeSource 官方维护的安装脚本

# 执行安装脚本
bash nodesource_setup.sh

# 这行命令做了什么？
# 添加 NodeSource 的 APT 源到 /etc/apt/sources.list.d/
# 这样 apt 就知道从哪里下载 Node.js

# 安装 Node.js
apt install -y nodejs

# 验证
node -v
# 应该输出 v20.x.x
```

**方法 B：通过 nvm 安装（如果方法 A 不行）**

```bash
# 安装 nvm (Node Version Manager)
# nvm 可以让你在同一台机器上安装多个 Node.js 版本，随时切换
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# 重新加载 shell 配置
source ~/.bashrc

# 安装 Node.js 20
nvm install 20

# 设置默认版本
nvm alias default 20

# 验证
node -v
npm -v
```

### 验证 npm 也安装成功了

```bash
npm -v
# 应该输出 10.x.x
```

npm 是 Node.js 的包管理器（相当于手机上的应用商店）。

当你运行 `npm install` 时，npm 会：
1. 读取 `package.json` 中的依赖列表
2. 从 https://registry.npmjs.org 下载这些包
3. 放在 `node_modules/` 目录下

## 7.2 安装 npm 依赖

```bash
# 进入项目目录
cd /opt/fscx

# 安装生产环境依赖
npm install --production
```

### --production 是什么意思？

npm 安装有两类依赖：

| 类型 | 放在 package.json 哪里 | 举例 | 是否需要 |
|------|----------------------|------|---------|
| `dependencies` | 生产依赖 | `express`, `better-sqlite3` | ✅ 必须 |
| `devDependencies` | 开发依赖 | `jest`, `nodemon` | ❌ 生产不需要 |

`--production` 告诉 npm：「只装生产依赖，不装开发依赖」。这样可以减小 `node_modules/` 的体积（省几十 MB 硬盘空间）。

### 安装过程发生了什么？

```
added 105 packages, and audited 106 packages in 3m
```

- `105 packages`：下载并安装了 105 个 npm 包
- `audited 106 packages`：检查了 106 个包的安全漏洞
- `found 0 vulnerabilities`：没有发现安全漏洞 ✅

**这 105 个包里都有什么？**

```
express（Web 框架）
  ├── body-parser（解析请求体）
  ├── accepts（内容协商）
  ├── array-flatten（数组扁平化）
  ├── ...
  │
better-sqlite3（SQLite 数据库驱动）
  ├── bindings（C++ 绑定）
  ├── tar（解压）
  ├── prebuild-install（预编译二进制）
  ├── ...
  │
dotenv（环境变量加载）
  └── ...
```

每个大包又依赖许多小包，所以总数有 105 个。

## 7.3 配置 .env 文件

### 什么是 .env 文件？

`.env` 文件用来存储**环境变量**——程序运行时需要的配置信息。

为什么不用写死在代码里？
```
// ❌ 不安全的做法
const PASSWORD = "abc123";   // 写在代码里，上传到 GitHub 所有人能看到

// ✅ 安全的做法
const PASSWORD = process.env.ADMIN_PASSWORD;  // 从环境变量读取
```

### 配置步骤

```bash
# 复制模板
cp .env.example .env

# 编辑配置
vim .env
```

按 `i` 进入编辑模式。

### 每个配置项的详细说明

```ini
# ── 管理员密码 ─────────────────────────────────────
# 作用：登录 /admin 管理后台的密码
# 为什么重要：这个密码是系统的最高权限，谁拿到谁就能改成绩
# 建议长度：至少 16 位
# 建议组成：大小写字母 + 数字 + 特殊符号
# 例子：Fscx@2025!Server#Secure
# ❌ 不要用：admin、123456、password、你的生日
# ❌ 不要用：和任何其他网站相同的密码
ADMIN_PASSWORD=你的密码

# ── 服务器端口 ─────────────────────────────────────
# 作用：Node.js 应用监听的端口号
# 默认值：3000
# 注意：不要改除非 3000 被占用，Nginx 配置也要同步改
# 为什么不用 80 或 443？
#   在 Linux 上，普通用户无法监听 1024 以下的端口
#   所以用 3000 端口，由 Nginx 转发 80/443 端口过来
PORT=3000

# ── 监听地址 ──────────────────────────────────────
# 作用：Node.js 监听哪个网络接口
# 值：
#   0.0.0.0 - 监听所有网络接口（本机 + 外部）
#   127.0.0.1 - 只监本机（更安全，外部无法直接访问）
# 建议：设为 0.0.0.0
# 为什么？Nginx 在同一台机器上需要通过内网访问 3000 端口
# 如果设为 127.0.0.1，Nginx 也能访问（因为 Nginx 也在本机）
# 但万一以后你想直接测试 3000 端口，设为 0.0.0.0 更方便
HOST=0.0.0.0

# ── 数据文件路径 ──────────────────────────────────
# 作用：SQLite 数据库文件存放在哪里
# 默认：./data/fscx.db（当前目录的 data 子目录下）
# 建议：保持默认
DB_PATH=./data/fscx.db

# ── 信任代理 ──────────────────────────────────────
# 作用：是否信任 Nginx 传递过来的客户端 IP
# 为什么需要：
#   当 Nginx 转发请求时，直接连接的 IP 是 127.0.0.1（Nginx 的内网地址）
#   Nginx 在请求头里加了 X-Forwarded-For: 用户真实IP
#   如果 TRUST_PROXY=true，Express 会读取这个头获取用户真实 IP
#   如果 TRUST_PROXY=false，rate limit（暴力破解防护）就用不了
#   因为所有用户的 IP 都是 127.0.0.1
# 建议：设置为 true
TRUST_PROXY=true
```

修改完后，按 `Esc`，输入 `:wq` 回车保存退出。

## 7.4 测试性启动

```bash
cd /opt/fscx
node src/index.js
```

如果一切正常，你会看到：

```
📦  Initializing database...
✅  Database ready at ./data/fscx.db

  🚀  fscx-server 已启动！
  ─────────────────────────────────────────
  🌐  学生前台:  http://localhost:3000/
  🔧  管理后台:  http://localhost:3000/admin
  ─────────────────────────────────────────
  📁  数据文件: ./data/fscx.db
  ⏱  监听地址: 0.0.0.0:3000
```

**测试应用是否正常工作：**

新开一个 SSH 窗口（或者按 `Ctrl+Z` 暂停 + `bg` 发送到后台），测试：

```bash
# 测试首页
curl -s http://localhost:3000/ | head -3

# 测试 API
curl -s http://localhost:3000/api/pub/config | python3 -m json.tool | head -10
```

按 `Ctrl+C` 停止测试进程。

### ⚠️ 常见启动错误

| 错误 | 原因 | 解决方法 |
|------|------|---------|
| `ADMIN_PASSWORD 未设置` | .env 文件不存在或配置错误 | 检查 .env 文件 |
| `Cannot find module 'express'` | npm install 没执行 | 执行 `npm install --production` |
| `Can't find node_modules` | 同上 | 同上 |
| `EADDRINUSE: address already in use` | 3000端口被占用 | `lsof -i :3000` 查看哪个进程在用，`kill` 掉 |
| `Error: SQLITE_ERROR` | 数据库文件损坏或权限问题 | `rm -rf /opt/fscx/data` 重新创建 |

---

# 第八章：PM2 —— 让应用永不停机

## 8.1 为什么需要 PM2？

之前你是手动启动 Node.js 的：`node src/index.js`。这种方式有四个致命问题：

| 问题 | 后果 |
|------|------|
| **关了 SSH 就会停** | 你一关 WSL 窗口，应用就停了 |
| **应用崩溃不会自动重启** | 如果代码有 bug，应用挂了就永远挂在那 |
| **服务器重启不会自动启动** | 服务商维护或断电后，你需要手动登录重新启动 |
| **没有日志管理** | 出问题不知道原因 |

PM2 解决了所有这些问题：

```
PM2 = Process Manager 2
     = 进程管理器
     = 应用的"保姆"

它负责：
✅ 在后台运行应用（关了 SSH 也不停）
✅ 应用崩溃时自动重启
✅ 服务器重启时自动启动
✅ 记录日志（方便排查问题）
✅ 监控 CPU、内存使用
```

## 8.2 安装 PM2

```bash
# 全局安装（-g = global，系统任何地方都能用）
npm install -g pm2

# PM2 安装在哪里？
which pm2
# 应该输出 /usr/local/bin/pm2（或 ~/nvm/.../bin/pm2）
```

## 8.3 启动应用

```bash
cd /opt/fscx

# pm2 start <启动文件> --name <进程名>
pm2 start src/index.js --name fscx
```

### 输出说明

```
┌────┬────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name       │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ fscx       │ fork     │ 0    │ online    │ 0%       │ 42.1MB   │
└────┴────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

| 列 | 含义 |
|----|------|
| `id` | 进程 ID（PM2 内部编号） |
| `name` | 进程名称（你指定的 `fscx`） |
| `mode` | fork（单进程模式） |
| `↺` | 重启次数（0 表示没重启过） |
| `status` | online（运行中） |
| `cpu` | CPU 占用（0% 表示空闲） |
| `memory` | 内存占用（42MB，非常轻量） |

### 💡 fork 和 cluster 模式

PM2 有两种运行模式：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **fork** | 单进程 | 你的应用（SQLite 不支持多进程写） |
| **cluster** | 多进程（利用多核 CPU） | 大型应用（如用 PostgreSQL 的应用） |

你的成绩查询系统用 SQLite，**只能使用 fork 模式**。因为 SQLite 同时只能有一个进程写入，cluster 模式下多个进程会互相冲突。

## 8.4 验证运行

```bash
# 查看 PM2 管理的所有进程
pm2 status

# 查看 fscx 进程详情
pm2 show fscx

# 测试应用响应
curl http://localhost:3000/api/pub/config | python3 -m json.tool | head -5
```

## 8.5 设置开机自启

```bash
# 保存当前进程列表（PM2 重启时恢复）
pm2 save
```

输出：

```
[PM2] Saving current process list...
[PM2] Successfully saved in /root/.pm2/dump.pm2
```

```bash
# 生成系统启动脚本
pm2 startup
```

输出：

```
[PM2] Init System found: systemd
[PM2] To setup the Startup Script, copy/paste the following command:
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root
```

### 什么是 systemd？

systemd 是 Linux 的**系统和服务管理器**。它是系统启动时第一个运行的进程（PID=1），负责：

```
开机 → systemd → 启动网络 → 启动 SSH → 启动 PM2 → 启动 fscx
```

PM2 的 `startup` 命令就是：在 systemd 里注册一个服务，告诉 systemd "每次开机都要启动 PM2，PM2 会启动 fscx"。

**把输出的命令复制粘贴执行：**

```bash
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u root --hp /root
```

### 验证开机自启

```bash
# 模拟重启（不会真的重启）
pm2 startup

# 查看 systemd 服务
systemctl status pm2-root
# 应该显示 enabled（开机自启已启用）
```

## 8.6 PM2 的进程管理原理

PM2 管理 Node.js 进程的机制：

```
你运行 pm2 start fscx
         ↓
PM2 创建一个"守护进程"（daemon）
         ↓
守护进程 fork 一个子进程运行你的 app
         ↓
如果你的 app 崩溃退出
         ↓
守护进程检测到子进程退出
         ↓
守护进程自动重新 fork 一个新的子进程
         ↓
PM2 记录重启次数（↺ 计数器 +1）
```

这就是为什么 PM2 能让应用"永不掉线"——即使代码有 bug 崩溃了，它也会立刻重启。

## 8.7 PM2 日常管理命令大全

```bash
# 查看所有进程状态
pm2 status
# 或
pm2 list

# 查看实时日志（按 Ctrl+C 退出日志）
pm2 logs fscx

# 查看最近 N 行日志
pm2 logs fscx --lines 100

# 重启应用
pm2 restart fscx

# 停止应用（进程还在 PM2 列表中，但停止了）
pm2 stop fscx

# 启动已停止的应用
pm2 start fscx

# 删除 PM2 中的进程（完全移除）
pm2 delete fscx

# 查看资源占用详情
pm2 monit
# 按 q 退出

# 查看所有日志文件
pm2 dump

# 清空日志
pm2 flush
```

---

# 第九章：Nginx 反向代理

## 9.1 什么是反向代理？

### 从"代理"说起

**正向代理（VPN、科学上网）：**

```
你的电脑 → 代理服务器 → 目标网站
            （帮你访问你本来访问不了的网站）
```

**反向代理（Nginx）：**

```
用户 → Nginx（代理服务器）→ 你的 Node.js 应用
       （帮用户访问你服务器上的应用）
```

### 为什么需要 Nginx？

| 场景 | 不用 Nginx | 用 Nginx |
|------|-----------|---------|
| 用户访问 | `http://123.123.123.123:3000` | `https://cjcx.nidexuexiao.com` |
| HTTPS 配置 | 需要改 Node.js 代码 | 配置文件中加 3 行 |
| 静态文件 | Node.js 处理 | Nginx 直接返回，快 10 倍 |
| 负载均衡 | 不支持 | 支持（多进程/多服务器） |
| 安全 | 直接暴露 Node.js | Nginx 可以过滤恶意请求 |
| 多个网站 | 需要不同端口 | 一个端口（80/443）按域名分发 |

**Nginx 就像写字楼的前台：**
- 你（Node.js）在 3000 房间办公
- 访客（用户）从大门（80 端口）进来
- 前台（Nginx）问："你去哪个公司？"
- 访客说："我找 fscx 公司"
- 前台带你去 3000 房间

## 9.2 检查 Nginx 是否已安装

```bash
# 查看版本
nginx -v

# 如果没有输出，安装
apt install -y nginx
```

### Nginx 安装后做了什么？

```
Nginx 安装后自动：
1. 启动 Nginx 服务
2. 设置开机自启
3. 监听 80 端口
4. 创建一个默认网站（Welcome to nginx!）
```

验证：

```bash
# 查看 Nginx 状态
systemctl status nginx
# 应该显示 active (running)

# 查看端口监听
ss -tlnp | grep nginx
# 应该看到 80 端口
```

### 测试默认页面

```bash
curl http://localhost:80
```

应该返回 HTML（Welcome to nginx 页面）。

## 9.3 Nginx 的配置体系

Nginx 的配置文件结构：

```
/etc/nginx/
├── nginx.conf              ← 主配置文件
├── sites-available/         ← 可用的站点配置
│   ├── default
│   └── fscx                 ← 你的成绩查询系统配置
├── sites-enabled/           ← 已启用的站点配置（软链接）
│   ├── default -> ../sites-available/default
│   └── fscx -> ../sites-available/fscx
├── conf.d/                  ← 其他配置片段
└── modules-enabled/         ← 启用的模块
```

**为什么有 sites-available 和 sites-enabled 两个目录？**

这是一个设计模式，让你可以：
1. 在 `sites-available` 里创建很多配置（包括暂时不用的）
2. 在 `sites-enabled` 里只链接你想启用的配置
3. 这样可以随时启用/禁用网站，不用删除配置

就像手机上的 app 列表（已安装 = available）和主屏幕（已启用 = enabled）。

## 9.4 创建 Nginx 配置文件

```bash
# 创建配置文件
vim /etc/nginx/sites-available/fscx
```

### 配置文件详解

按 `i` 进入编辑模式，粘贴以下内容。**每一行都有注释说明它的作用**：

```nginx
# ── server 块 ───────────────────────────────────────
# 每个 server 块定义一个虚拟主机（一个网站）
# 可以定义多个 server 块，在一台服务器上运行多个网站

server {
    # ── listen: 监听端口 ─────────────────────────────
    # 格式：listen [地址:]端口 [选项]
    # 80 是 HTTP 的默认端口
    # 用户访问 http://cjcx.nidexuexiao.com 默认就是 80 端口
    listen 80;
    
    # 默认情况下 listen 80 会监听所有 IP 地址
    # 如果想只监听某个 IP：
    # listen 123.123.123.123:80;
    
    # ── server_name: 域名匹配 ────────────────────────
    # 当用户访问哪个域名时，使用这个 server 块处理
    # 支持通配符：*.nidexuexiao.com 匹配所有子域名
    # 支持多个域名：server_name cjcx.nidexuexiao.com cjcx.xuexiao.com;
    server_name cjcx.nidexuexiao.com;
    
    # ── client_max_body_size: 请求体大小限制 ──────────
    # 用户上传文件（批量导入 Excel）的大小限制
    # 默认是 1MB，对于 Excel 文件不够
    # 50MB 应该足够了，如果还不够可以增大
    client_max_body_size 50m;
    
    # ── charset: 字符集 ──────────────────────────────
    # 告诉浏览器使用 UTF-8 编码
    # 否则中文可能显示为乱码
    charset utf-8;
    
    # ── access_log / error_log: 访问日志和错误日志 ────
    # 记录谁访问了网站、访问了哪里、状态码等
    # 排查问题时非常重要
    access_log /var/log/nginx/fscx-access.log;
    error_log  /var/log/nginx/fscx-error.log;
    
    # ── location /: URL 匹配规则 ─────────────────────
    # location 后面跟匹配规则
    # / 表示匹配所有路径（所有请求）
    # 可以指定多个 location 块匹配不同路径
    location / {
        # ── proxy_pass: 转发到后端服务 ──────────────
        # 所有请求转发到这个地址
        # http://127.0.0.1:3000 就是你的 Node.js 应用
        # 127.0.0.1 是本机回环地址（localhost）
        proxy_pass http://127.0.0.1:3000;
        
        # ── proxy_http_version: HTTP 协议版本 ──────
        # 设置为 1.1 才能支持 keepalive（长连接）
        # Nginx 默认使用 HTTP/1.0 向后端转发
        proxy_http_version 1.1;
        
        # ── proxy_set_header: 设置转发请求头 ──────
        # 这些头部告诉后端（Node.js）用户的真实信息
        
        # Host: 用户请求的域名
        # 如果不设置，Node.js 拿到的 Host 是 127.0.0.1:3000
        proxy_set_header Host $host;
        
        # X-Real-IP: 用户的真实 IP
        # 如果不设置，Node.js 拿到的 IP 是 127.0.0.1（Nginx 的内网地址）
        proxy_set_header X-Real-IP $remote_addr;
        
        # X-Forwarded-For: 代理链中所有 IP
        # 如果前面还有别的代理（如 Cloudflare），这个头会包含所有 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # X-Forwarded-Proto: 用户请求的协议（http 还是 https）
        # 如果不设置，Node.js 无法知道用户用的是 HTTP 还是 HTTPS
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Upgrade / Connection: WebSocket 支持
        # 你的应用不使用 WebSocket，但保留也无妨
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
        
        # ── 超时时间设置 ──────────────────────────
        # 连接后端超时：Nginx 连接 Node.js 的超时时间
        proxy_connect_timeout 60s;
        # 读取超时：等待 Node.js 响应的超时时间
        proxy_read_timeout 60s;
        # 发送超时：发送请求体到 Node.js 的超时时间
        proxy_send_timeout 60s;
    }
}
```

粘贴完成后，按 `Esc`，输入 `:wq` 回车保存退出。

## 9.5 启用站点并测试

```bash
# 创建软链接到 sites-enabled
ln -s /etc/nginx/sites-available/fscx /etc/nginx/sites-enabled/

# ln -s 是什么意思？
# ln = link（创建链接）
# -s = symbolic（符号链接，相当于 Windows 的快捷方式）
# 源文件 → 链接文件
# 这样修改源文件，链接文件自动更新

# 删除默认站点（可选，保留也可以）
rm /etc/nginx/sites-enabled/default
```

**测试配置语法：**

```bash
nginx -t
```

这个命令很关键。它不会真的应用配置，只是检查语法。如果输出：

```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

✅ 配置正确。如果输出错误信息，根据提示修改。

**常见配置错误：**

```
nginx: [emerg] could not build server_names_hash, you should increase server_names_hash_bucket_size: 64
```

解决方法：在 `/etc/nginx/nginx.conf` 的 http 块中添加一行：

```
http {
    server_names_hash_bucket_size 128;
    ...
}
```

```
nginx: [emerg] invalid number of arguments in "proxy_pass" directive
```

解决方法：`proxy_pass` 后面跟的 URL **必须有 `http://`**，不能写成 `proxy_pass 127.0.0.1:3000;`

## 9.6 重新加载 Nginx

```bash
# systemctl reload 不中断当前连接，平滑加载新配置
systemctl reload nginx

# 和 restart 的区别：
# reload：优雅重载（处理完当前请求后应用新配置，不会中断服务）
# restart：暴力重启（立即停止再启动，短暂中断）

# 如果想重启：
# systemctl restart nginx
```

## 9.7 验证 Nginx 反向代理是否生效

```bash
# 测试 1：通过 Nginx 访问
curl -H "Host: cjcx.nidexuexiao.com" http://127.0.0.1/
# 应该返回你的成绩查询首页 HTML

# 测试 2：测试 API
curl -H "Host: cjcx.nidexuexiao.com" http://127.0.0.1/api/pub/config
# 应该返回 JSON 配置

# 测试 3：直接访问 3000 端口（不经过 Nginx）
curl http://127.0.0.1:3000/
# 也应该返回同样的内容

# 测试 4：查看 Nginx 日志
tail -f /var/log/nginx/fscx-access.log
```

如果 `测试 1` 成功，Nginx 反代就配好了。

## 9.8 没有域名时怎么办？

如果你还没有域名，或者只是测试，可以直接用服务器的 IP 地址访问（但不建议给用户用）：

修改 Nginx 配置的 `server_name`：

```nginx
# 可以省略 server_name，或者用 _ 表示"匹配所有域名"
server {
    listen 80;
    # server_name _;  # 匹配所有域名
    # 或者不写 server_name
    ...
}
```

然后访问 `http://你的服务器IP`。但注意：**只有你自己知道 IP 才能访问，而且没有 HTTPS 不安全。**

---

# 第十章：配置 HTTPS

## 10.1 什么是 HTTPS？为什么需要它？

### HTTP 的缺陷

想象你在邮局寄明信片：

```
你（浏览器） ──── 明信片（数据） ────→ 服务器

问题：
1. 任何人路过都能看到明信片上的内容（明文传输）
2. 任何人可以修改明信片上的内容（篡改风险）
3. 寄件人可能被冒充（身份伪造）
```

### HTTPS 如何解决

HTTPS = HTTP + SSL/TLS（加密层）

```
你（浏览器） ──── 加密的信件 ────→ 服务器

解决方案：
1. 对称加密：信件内容加密，只有你和服务器能解密（防窃听）
2. 数字签名：信件有防伪标志，修改了能发现（防篡改）
3. 数字证书：通过权威机构认证，确认对方身份（防冒充）
```

### 为什么 HTTPS 是必需的

| 原因 | 说明 |
|------|------|
| **安全** | 成绩查询涉及学生隐私，不加密等于公开 |
| **信任** | 浏览器标记 HTTP 网站为"不安全"，用户会担心 |
| **功能** | 很多浏览器 API（如地理位置）要求 HTTPS |
| **SEO** | Google 给 HTTPS 网站更好的搜索排名 |
| **微信** | 微信分享的链接如果是 HTTP，会显示"不安全" |

### 证书类型对比

| 类型 | 价格 | 特点 | 推荐程度 |
|------|------|------|---------|
| **Let's Encrypt**（免费） | 0元 | 自动续期，广泛信任 | ⭐⭐⭐⭐⭐ |
| ZeroSSL（免费） | 0元 | 类似 Let's Encrypt | ⭐⭐⭐⭐ |
| 自签名证书 | 0元 | 浏览器不信任，显示警告 | ❌ |
| 付费证书（DigiCert等） | 几百到几千元 | 跟免费的一样用 | 没必要 |

**对于学生成绩查询系统，Let's Encrypt 免费证书完全够用。**

## 10.2 使用 Certbot 申请 Let's Encrypt 证书

### Certbot 的原理

```
Certbot 的工作流程：

① Certbot 联系 Let's Encrypt 服务器："我想为 cjcx.nidexuexiao.com 申请证书"
② Let's Encrypt："先证明你拥有这个域名"
③ Certbot 在服务器上放一个验证文件
   文件路径：http://cjcx.nidexuexiao.com/.well-known/acme-challenge/xxx
   文件内容：一串随机字符串
④ Let's Encrypt 访问这个 URL，验证文件是否存在
⑤ 验证通过 → Let's Encrypt 签发证书
⑥ Certbot 下载证书并配置到 Nginx
```

### 执行前必须满足的条件

```
✅ 域名已经解析到服务器（ping cjcx.nidexuexiao.com 返回你的 IP）
✅ 80 端口已开放且能访问
✅ Nginx 已配置好并正在运行
```

在服务器上验证：

```bash
# 从服务器自身访问
curl http://127.0.0.1/

# 从外部访问（如果域名没生效，这一步会失败）
# 可以在你本机的浏览器访问 http://你的服务器IP/
```

### 申请证书

```bash
certbot --nginx -d cjcx.nidexuexiao.com
```

参数说明：
- `--nginx`：使用 Nginx 插件（自动修改 Nginx 配置）
- `-d`：指定域名，可以多个（`-d domain1.com -d domain2.com`）

### 交互过程详解

```
Saving debug log to /var/log/letsencrypt/letsencrypt.log
```

Certbot 在做：记录日志到 `/var/log/letsencrypt/`，方便以后排查问题。

```
Enter email address (used for urgent renewal and security notices)
 (Enter 'c' to cancel):
```

Certbot 在问：请输入你的邮箱地址。

为什么需要邮箱？Let's Encrypt 会在证书快到期前发邮件提醒你（虽然自动续期不需要手动操作，但留一个邮箱更安全）。

建议输入：`admin@你的域名.com`（例如 `admin@nidexuexiao.com`）

---

```
Please read the Terms of Service at
https://letsencrypt.org/documents/LE-SA-v1.3-September-21-2022.pdf.

You must agree in order to register with the ACME server.
(A)gree/(C)ancel:
```

Certbot 在问：是否同意 Let's Encrypt 的服务条款？

输入 `A` 回车。

---

```
Would you be willing, once your first certificate is successfully issued, to
share your email address with the Electronic Frontier Foundation... 
(Y)es/(N)o:
```

Certbot 在问：是否愿意接收 EFF（电子前哨基金会）的邮件？

输入 `N` 回车（不接收）。

---

```
Please choose whether you want to redirect HTTP traffic to HTTPS...
1: No redirect - Make no further changes to the web server configuration.
2: Redirect - Make all requests redirect to secure HTTPS access.
Select the appropriate number [1-2] then [enter] (press 'c' to cancel):
```

Certbot 在问：访问 HTTP（80端口）时，是否自动跳转到 HTTPS（443端口）？

- 选 `1`：HTTP 和 HTTPS 都能访问（用户可能不小心用 HTTP）
- 选 `2`（推荐）：访问 HTTP 自动 301 跳转到 HTTPS

**建议选 `2`**。这样用户输入 `http://...` 也会自动跳到 `https://...`。

---

```
Successfully received certificate.
Certificate is saved at:
/etc/letsencrypt/live/cjcx.nidexuexiao.com/fullchain.pem
Key is saved at:
/etc/letsencrypt/live/cjcx.nidexuexiao.com/privkey.pem
This certificate expires on 2025-04-15.
These files will be updated when the certificate renews.
Certbot has set up a scheduled task to automatically renew this certificate in the background.

Congratulations! You have successfully enabled HTTPS on:
https://cjcx.nidexuexiao.com
```

✅ **HTTPS 配置成功！** 注意证书的位置和到期时间。

## 10.3 证书文件说明

申请成功后，证书文件保存在 `/etc/letsencrypt/live/cjcx.nidexuexiao.com/`：

| 文件 | 作用 | 权限 |
|------|------|------|
| `fullchain.pem` | 完整证书链（服务器证书 + 中间证书） | 公开可读 |
| `privkey.pem` | **私钥**（机密！泄露等于证书作废） | 仅 root 可读 |
| `chain.pem` | 中间证书 | 公开可读 |
| `cert.pem` | 服务器证书 | 公开可读 |

**私钥安全提示：** `privkey.pem` 是**绝密文件**。谁拿到这个文件，谁就能冒充你的网站。永远不要分享、上传、或复制到不安全的地方。

## 10.4 验证 HTTPS

### 命令行验证

```bash
# 用 curl 测试 HTTPS
curl -v https://cjcx.nidexuexiao.com/

# 查看证书信息
echo | openssl s_client -connect cjcx.nidexuexiao.com:443 2>/dev/null | openssl x509 -text | head -20
```

### 浏览器验证

1. 打开 `https://cjcx.nidexuexiao.com`
2. 地址栏左侧应该有一个**小锁图标** 🔒
3. 点击小锁 → 显示"连接安全"
4. 点击"证书" → 查看证书详情

### 浏览器看到"不安全"的原因

| 问题 | 原因 | 解决 |
|------|------|------|
| `NET::ERR_CERT_DATE_INVALID` | 系统时间不对 | 设置正确的时间 |
| `NET::ERR_CERT_COMMON_NAME_INVALID` | 证书域名不匹配 | 确认 `-d` 参数写的域名正确 |
| `NET::ERR_CERT_AUTHORITY_INVALID` | 自签名证书 | 用 Let's Encrypt 重新申请 |
| 没有小锁，显示"i" | 页面包含 HTTP 资源 | 页面上所有链接都改成 HTTPS |

## 10.5 证书自动续期

### 为什么要自动续期？

Let's Encrypt 的证书**有效期为 90 天**。这是为了安全——即使私钥泄露，攻击者也最多滥用 90 天。

### Certbot 的自动续期机制

Certbot 安装时自动创建了两个续期任务：

```bash
# 查看 systemd 定时器
systemctl list-timers | grep certbot
```

输出类似：

```
NEXT                        LEFT          LAST                        PASSED    UNIT
Mon 2025-01-20 05:30:00 CST 13h left     Sun 2025-01-19 05:30:00 CST 11h ago   certbot.timer
```

`certbot.timer` 每天触发两次，但只有证书还有不到 30 天才到期时才会真正续期。

### 手动测试续期

```bash
# --dry-run 不会真的修改证书，只是测试
certbot renew --dry-run
```

如果输出 `Congratulations, all renewals succeeded`，说明续期机制正常。

### 💡 如果你用的是 Cloudflare 代理（Proxied 模式）

Cloudflare 的 Proxy 模式会拦截 Let's Encrypt 的验证请求。解决办法：
1. 在 Cloudflare 控制台把 `cjcx` 的 Proxy status 暂时改为 **DNS Only**
2. 运行 `certbot --nginx -d cjcx.nidexuexiao.com` 申请证书
3. 申请完成后改回 **Proxied**
4. 或者使用 Cloudflare 自带的免费 SSL 证书（在 Cloudflare 面板的 SSL/TLS 页面）

## 10.6 Nginx HTTPS 配置解读

申请证书后，Nginx 配置文件被自动修改为：

```nginx
server {
    server_name cjcx.nidexuexiao.com;

    # ... location / 配置同上 ...

    # ── 以下为 Certbot 自动添加的 HTTPS 配置 ──
    
    # 监听 443 端口，启用 SSL
    listen 443 ssl;
    
    # SSL 证书文件路径
    ssl_certificate /etc/letsencrypt/live/cjcx.nidexuexiao.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cjcx.nidexuexiao.com/privkey.pem;
    
    # SSL 配置（来自 Certbot 的优化）
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

# ── HTTP → HTTPS 跳转 ──
server {
    if ($host = cjcx.nidexuexiao.com) {
        return 301 https://$host$request_uri;
    }

    listen 80;
    server_name cjcx.nidexuexiao.com;
    return 404;
}
```

`return 301` 是 HTTP 重定向指令。`301` 表示"永久重定向"，浏览器会记住这个跳转，下次直接访问 HTTPS。

---

# 第十一章：部署验证（检查每项功能是否正常）

## 11.1 服务状态检查

### 检查 PM2

```bash
pm2 status
```

期望输出：

```
┌────┬──────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼──────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ fscx │ fork     │ 0    │ online    │ 0%       │ 40.0MB   │
└────┴──────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

### 检查 Nginx

```bash
systemctl status nginx
```

期望输出中包含 `active (running)`。

### 检查端口

```bash
ss -tlnp
```

期望看到：

```
State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port  Process
LISTEN  0       511      0.0.0.0:80           0.0.0.0:*          users:(("nginx",...))
LISTEN  0       511      0.0.0.0:443          0.0.0.0:*          users:(("nginx",...))
LISTEN  0       511      127.0.0.1:3000        0.0.0.0:*          users:(("node",...))
```

注意：3000 端口只监听 `127.0.0.1`（仅本机访问），80 和 443 端口监听 `0.0.0.0`（所有人都能访问）。

## 11.2 浏览器验证

### 测试步骤

| 测试项 | URL | 期望结果 |
|--------|-----|---------|
| HTTPS 首页 | `https://cjcx.nidexuexiao.com/` | 显示成绩查询页面，有小锁图标 |
| HTTP 跳转 | `http://cjcx.nidexuexiao.com/` | 自动跳转到 HTTPS |
| 管理后台 | `https://cjcx.nidexuexiao.com/admin` | 显示登录页面 |
| 说明页 | `https://cjcx.nidexuexiao.com/help` | 显示查询说明 |
| API 配置 | `https://cjcx.nidexuexiao.com/api/pub/config` | 返回 JSON |

### 手机上测试

```bash
# 在你的服务器上查看公网 IP
curl -s ifconfig.me

# 用手机浏览器访问 https://cjcx.nidexuexiao.com
# 检查手机端适配（卡片式布局应该自适应）
```

## 11.3 功能验证

### 验证成绩查询流程

由于现在系统还没有任何数据，你需要在管理后台录入测试数据。

**第一步：登录管理后台**

1. 访问 `https://cjcx.nidexuexiao.com/admin`
2. 输入你在 `.env` 中设置的 `ADMIN_PASSWORD`
3. 点击登录

如果密码错误，检查：
```bash
cat /opt/fscx/.env | grep ADMIN_PASSWORD
# 确认密码正确，然后 pm2 restart fscx
```

**第二步：创建考试批次**

1. 点击左侧「考试批次」
2. 点击「新增批次」
3. 填写：
   - 批次ID：`exam2025`
   - 显示名称：`2025年春季学业水平考试`
   - 考试日期：今天的日期
   - 对外开放：勾选
4. 点击「保存所有批次」

**第三步：录入一条成绩**

1. 点击左侧「录入成绩」
2. 选择刚才创建的批次和方向（如物理方向）
3. 填写姓名、准考证号、学校
4. 填写各科成绩
5. 点击「提交」

**第四步：前台查询**

1. 访问 `https://cjcx.nidexuexiao.com/`
2. 选择考试批次
3. 填写姓名、准考证号、学校
4. 点击查询
5. 应该看到成绩页面

## 11.4 常见问题排查

### 问题：502 Bad Gateway

```
502 Bad Gateway
nginx/1.24.0
```

原因：Nginx 无法连接 Node.js 应用（`proxy_pass http://127.0.0.1:3000` 失败）。

检查步骤：

```bash
# 1. Node.js 是否在运行？
pm2 status

# 2. Node.js 是否在 3000 端口监听？
ss -tlnp | grep 3000

# 3. 手动测试 Node.js 是否响应？
curl http://localhost:3000/

# 4. 查看 Node.js 日志
pm2 logs fscx --lines 20

# 5. 如果都没问题，重试 Nginx
systemctl reload nginx
```

### 问题：连接超时

```
Connection timed out
```

原因：
- 服务器 80/443 端口没开放
- DNS 没生效

检查：

```bash
# 从服务器自身测试
curl http://localhost:3000/

# 从外部测试（在你的 WSL 或另一台电脑）
curl http://你的服务器IP:80
curl http://cjcx.nidexuexiao.com:80

# 检查防火墙
ss -tlnp | grep -E ':80|:443'
```

### 问题：页面空白（没有错误提示）

查看浏览器控制台（F12 → Console）：
- 如果有 CORS 错误，检查 Nginx 配置的 CORS 头
- 如果有 API 请求失败，检查 API 返回的状态码

### 问题：管理后台登录失败

```bash
# 检查 .env 中的密码是否正确
cat /opt/fscx/.env | grep ADMIN_PASSWORD

# 修改密码后重启
pm2 restart fscx

# 查看日志看是否有错误
pm2 logs fscx --lines 20
```

---

# 第十二章：不同部署方式的选择

## 12.1 各种部署方式对比

| 部署方式 | 难度 | 优点 | 缺点 | 推荐场景 |
|---------|------|------|------|---------|
| **手动部署**（PM2 + Nginx）| ⭐⭐ | 灵活性最高，完全可控 | 需要手动配置每一项 | 新手学习、长期使用 |
| **Docker 部署** | ⭐⭐⭐ | 环境隔离，移植方便 | 需要学习 Docker | 多应用服务器 |
| **宝塔面板** | ⭐ | 可视化操作，不需要记命令 | 占用资源较多，不够灵活 | 完全不想用命令行的用户 |
| **Cloudflare Tunnel** | ⭐⭐ | 不需要公网 IP，自带 HTTPS | 速度依赖 Cloudflare | 没有公网 IP 的服务器 |

下面详细介绍各种方式。

## 12.2 Docker 部署（进阶）

### 12.2.1 什么是 Docker？

Docker 是一种**容器化技术**。它把你的应用和它需要的所有依赖（Node.js、库文件等）打包在一起，形成一个"容器"。

```
传统方式：
你的应用 → 依赖服务器上安装的 Node.js、better-sqlite3 等
           → 换个服务器可能版本不一样 → 跑不起来

Docker 方式：
你的应用 + Node.js + better-sqlite3 = 一个容器
           → 拿到任何服务器上都能跑 → 保证一致
```

类比：Docker 就像**集装箱**。不管里面装的是什么，集装箱本身规格统一，任何轮船、火车、卡车都能运输。

### 12.2.2 安装 Docker

```bash
# 一键安装 Docker
curl -fsSL https://get.docker.com | sh

# 验证安装
docker --version

# 设置 Docker 开机自启
systemctl enable docker
systemctl start docker
```

### 12.2.3 创建 Dockerfile

在你的**本地项目根目录**（有 `package.json` 的地方）创建 `Dockerfile`：

```dockerfile
# ── 第一阶段：构建 ──
# 使用 Node.js 20 的精简版作为基础镜像
# alpine 是 Alpine Linux 的缩写，一个非常精简的 Linux 发行版
# 完整版 Node.js 镜像约 1GB，alpine 版只有 150MB
FROM node:20-alpine AS builder

# 设置工作目录（容器内的路径）
WORKDIR /app

# 安装构建工具
# better-sqlite3 需要编译原生模块，需要 g++ 和 make
# apk 是 Alpine 的包管理器（相当于 apt）
RUN apk add --no-cache python3 make g++

# 复制 package.json 和 package-lock.json
# 注意：先复制这两个文件，再复制其他文件
# 这样可以利用 Docker 的缓存层——如果 package.json 没变，就不重新安装依赖
COPY package.json package-lock.json ./

# 安装生产依赖
RUN npm install --production

# ── 第二阶段：运行 ──
# 重新使用一个干净的 node:20-alpine 镜像
# 这样最终的镜像只包含运行时的文件，不包含构建工具
FROM node:20-alpine

WORKDIR /app

# 从 builder 阶段复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口（告诉 Docker 这个容器需要 3000 端口）
EXPOSE 3000

# 启动命令
CMD ["node", "src/index.js"]
```

### 12.2.4 构建 Docker 镜像

```bash
# 在项目根目录执行
docker build -t fscx:latest .

# 参数说明：
# docker build：构建镜像
# -t fscx:latest：给镜像打标签（名称:版本）
# .：当前目录（Dockerfile 所在目录）

# 查看已构建的镜像
docker images
```

### 12.2.5 运行 Docker 容器

```bash
# 创建数据卷（存储数据库文件，删除容器时数据不丢失）
docker volume create fscx-data

# 运行容器
docker run -d \
  --name fscx \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_PASSWORD=你的密码 \
  -e TRUST_PROXY=true \
  -v fscx-data:/app/data \
  fscx:latest
```

参数详解：

| 参数 | 含义 |
|------|------|
| `-d` | 后台运行（detached） |
| `--name fscx` | 容器名称 |
| `--restart unless-stopped` | 自动重启策略：除了手动 stop，其他情况都重启 |
| `-p 3000:3000` | 端口映射：宿主机3000 → 容器3000 |
| `-e ADMIN_PASSWORD=你的密码` | 环境变量 |
| `-v fscx-data:/app/data` | 数据卷挂载：把容器的 /app/data 映射到宿主机 |
| `fscx:latest` | 使用的镜像 |

### 12.2.6 验证 Docker 运行

```bash
# 查看运行中的容器
docker ps

# 测试访问
curl http://localhost:3000/api/pub/config

# 查看日志
docker logs fscx

# 查看日志（实时跟踪）
docker logs -f fscx
```

### 12.2.7 Docker 日常管理

```bash
# 重启容器
docker restart fscx

# 停止容器
docker stop fscx

# 启动容器
docker start fscx

# 进入容器内部（调试用）
docker exec -it fscx sh

# 查看容器日志
docker logs -f fscx

# 查看容器资源使用
docker stats fscx

# 备份数据库
docker cp fscx:/app/data/fscx.db /root/backup/
```

### 12.2.8 更新 Docker 部署

```bash
# 1. 停止并删除旧容器
docker stop fscx
docker rm fscx

# 2. 如果有代码更新，重新构建
docker build -t fscx:latest .

# 3. 重新运行
docker run -d \
  --name fscx \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_PASSWORD=你的密码 \
  -e TRUST_PROXY=true \
  -v fscx-data:/app/data \
  fscx:latest
```

**数据不会丢失**，因为数据库存在 `fscx-data` 数据卷里。

## 12.3 宝塔面板部署（可视化）

### 12.3.1 什么是宝塔面板？

宝塔面板（BT Panel）是一个**服务器管理面板**，提供 Web 界面来管理服务器。你不需要记命令行，在浏览器里点点鼠标就能：

- 安装 Nginx/MySQL/PHP/Node.js
- 创建网站
- 配置域名和 SSL
- 管理文件
- 查看日志

### 12.3.2 安装宝塔

```bash
# SSH 登录服务器后执行
wget -O install.sh https://download.bt.cn/install/install-ubuntu_6.0.sh
bash install.sh
```

安装过程约 2-5 分钟。完成后会输出：

```
============================ Congratulations! ============================
Bt-Panel: http://你的服务器IP:8888/随机路径
username: 用户名
password: 密码
```

⚠️ **记录这些信息！** 以后可能要用 `bt` 命令查看：

```bash
bt default
```

### 12.3.3 登录宝塔

1. 浏览器访问 `http://你的服务器IP:8888/随机路径`
2. 输入用户名密码

### 12.3.4 安装 Node.js

1. 左侧菜单 →「软件商店」
2. 搜索「Node.js」
3. 找到「Node.js版本管理器」→「安装」
4. 安装完成后，点击「设置」
5. 在「版本管理」中选择 20.x →「安装」

### 12.3.5 上传项目文件

1. 左侧菜单 →「文件」
2. 导航到 `/www/wwwroot/`
3. 点击「新建目录」→ 输入 `fscx`
4. 进入 `fscx` 目录
5. 点击「上传」

**上传方法：**
- 方法一：直接拖拽文件到上传区域
- 方法二：把项目打包成 zip，上传后解压

### 12.3.6 配置环境变量

1. 在文件管理中找到 `.env.example` 
2. 右键 →「复制」→ 改名为 `.env`
3. 双击 `.env` 编辑
4. 修改 `ADMIN_PASSWORD` 和 `TRUST_PROXY=true`
5. 保存

### 12.3.7 安装依赖

1. 左侧菜单 →「终端」
2. 执行：

```bash
cd /www/wwwroot/fscx
npm install --production
```

### 12.3.8 添加 Node 项目

1. 左侧菜单 →「网站」
2. 选择「Node项目」标签
3. 点击「添加Node项目」

配置：

```
项目名称：    fscx
项目路径：    /www/wwwroot/fscx
启动文件：    src/index.js
端口：        3000
开机启动：    勾选
```

4. 点击「提交」

### 12.3.9 添加域名和 SSL

1. 左侧菜单 →「网站」
2. 点击「添加站点」
3. 配置：

```
域名：        cjcx.nidexuexiao.com
根目录：      /www/wwwroot/fscx
PHP版本：     纯静态
```

4. 点击「提交」
5. 在站点列表点击刚才添加的域名
6. 找到「反向代理」→「添加反向代理」：

```
代理名称：    fscx-proxy
目标 URL：    http://127.0.0.1:3000
```

7. 保存
8. 找到「SSL」→「Let's Encrypt」
9. 勾选域名 →「申请」
10. 申请成功后打开「强制HTTPS」

## 12.4 Cloudflare Tunnel 部署（不需要公网 IP）

### 12.4.1 什么时候需要 Tunnel？

- 你的服务器没有公网 IP（内网环境）
- 你的服务器在家里，IP 是动态的
- 你不想暴露服务器 IP（安全性）
- 你不想配 HTTPS 证书（Cloudflare 自动处理）

### 12.4.2 Cloudflare Tunnel 的工作原理

```
用户访问 https://cjcx.nidexuexiao.com
         ↓
Cloudflare 网络（全球 300+ 节点）
         ↓
         Cloudflare Tunnel（加密隧道）
         ↓
你的服务器（任意网络，甚至内网）
         ↓
Nginx 或 Node.js 应用（仍然在 localhost:3000）
```

Tunnel 建立了一条从 Cloudflare 到你的服务器的**加密连接**。所有流量经过 Cloudflare，用户无法知道你的服务器 IP。

### 12.4.3 前提条件

- 域名托管在 Cloudflare（必须）
- 服务器能访问互联网（不需要公网 IP）

### 12.4.4 创建 Tunnel

1. 登录 Cloudflare 控制台
2. 进入 **Zero Trust** → **Access** → **Tunnels**
3. 点击 **Create a tunnel**
4. 选择 **cloudflared**，给 tunnel 命名（如 `fscx-tunnel`）
5. 点击 **Save tunnel**

Cloudflare 会给你一个安装命令，类似：

```
cloudflared tunnel login
cloudflared tunnel create fscx-tunnel
cloudflared tunnel route dns fscx-tunnel cjcx.nidexuexiao.com
```

### 12.4.5 在服务器上安装 cloudflared

```bash
# 下载 cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared

# 赋予执行权限
chmod +x /usr/local/bin/cloudflared

# 验证安装
cloudflared version
```

### 12.4.6 配置 Tunnel

```bash
# 创建配置文件目录
mkdir -p /root/.cloudflared

# 创建配置文件
vim /root/.cloudflared/config.yml
```

粘贴：

```yaml
# Tunnel 的 ID（创建 tunnel 后会有）
tunnel: fscx-tunnel

# 认证文件路径（创建 tunnel 后自动生成）
credentials-file: /root/.cloudflared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

# 路由规则
ingress:
  # 访问 cjcx.nidexuexiao.com 时转发到本机 3000 端口
  - hostname: cjcx.nidexuexiao.com
    service: http://localhost:3000
  # 默认规则：其他域名返回 404
  - service: http_status:404
```

### 12.4.7 启动 Tunnel

```bash
# 以系统服务方式安装并启动
cloudflared service install

# 查看状态
systemctl status cloudflared
```

### 12.4.8 完成配置

在 Cloudflare 控制台：

1. 回到 Tunnel 页面
2. 点击你的 tunnel
3. 在 **Public Hostname** 标签页
4. 确认 `cjcx.nidexuexiao.com` 已经关联

**不需要再配置 Nginx！** Cloudflare Tunnel 直接连接到你的 Node.js 应用。HTTPS 由 Cloudflare 自动处理。

---

# 第十三章：安全加固

## 13.1 为什么需要安全加固？

你的成绩查询系统存储了学生的个人信息（姓名、学校、成绩），如果被攻击者入侵：
- 学生隐私泄露
- 成绩被篡改
- 服务器被植入木马

以下措施能大幅提升安全性。

## 13.2 创建普通用户（不要一直用 root）

### 为什么不用 root？

root 是 Linux 的**超级管理员**，拥有最高权限。一直用 root 的风险：

```
root 的权限：
  ✅ 能执行任何命令
  ✅ 能修改任何文件
  ✅ 能删除整个系统（rm -rf /）
  
风险：
  ❌ 如果密码泄露，攻击者直接获得完全控制权
  ❌ 误操作可能造成不可逆的后果
  ❌ 被暴力破解的概率更高（因为 root 是固定用户名）
```

### 创建普通用户

```bash
# 创建新用户（比如叫 deploy）
adduser deploy

# 系统会问：
# New password: 输入密码
# Retype new password: 再次输入
# Full Name []: 直接回车（跳过）
# 其他信息：直接回车跳过

# 授予 sudo 权限（可以执行需要 root 权限的命令）
usermod -aG sudo deploy

# 测试切换用户
su - deploy
# 输入密码

# 验证 sudo 是否可用
sudo whoami
# 应该输出 root

# 切换回 root
exit
```

### 配置 sudo 免密码（可选）

```bash
# 编辑 sudo 配置
visudo
```

找到 `%sudo ALL=(ALL:ALL) ALL`，下面添加一行：

```
deploy ALL=(ALL) NOPASSWD: ALL
```

这样 `deploy` 用户执行 `sudo` 命令时不需要输入密码。

### 之后用 deploy 用户登录

```bash
# 以后 SSH 就用 deploy 用户
ssh deploy@你的服务器IP

# 需要 root 权限时用 sudo
sudo pm2 status
```

## 13.3 修改 SSH 端口

### 为什么改端口？

SSH 默认端口 22 是全球统一标准，每天有无数自动化脚本在扫描 22 端口试图暴力破解。

```
互联网扫描器 → 扫描 22 端口 → 发现你的服务器 → 尝试登录（root/admin/...）
```

改了端口后，99% 的扫描器就找不到你的 SSH 服务了。

### 修改步骤

```bash
# 编辑 SSH 配置文件
vim /etc/ssh/sshd_config
```

**注意：不要关掉当前的 SSH 会话！** 另开一个窗口测试新端口是否可用，否则改错了你就进不去了。

找到并修改以下行：

```
# 把 Port 22 改为一个不常用的端口
# 端口范围：1024-65535
# 建议选择一个不容易猜到的端口，比如 22222 或 54321
Port 22222

# 禁止 root 直接 SSH 登录（如果你创建了普通用户）
# 没有这行就添加
PermitRootLogin no

# 只允许特定用户登录
# 没有这行就添加（deploy 换成你用）
AllowUsers deploy
```

保存退出。

### 测试新端口配置

**不要关闭当前 SSH 会话！** 打开一个新的 WSL 窗口：

```bash
# 用新端口和 deploy 用户尝试连接
ssh -p 22222 deploy@你的服务器IP
```

如果连接成功，再回到旧的 SSH 会话重启服务：

```bash
# 重启 SSH 服务
systemctl restart sshd

# 验证 SSH 在监听新端口
ss -tlnp | grep ssh
# 应该显示 22222 而不是 22
```

### 如果连接失败

```bash
# 检查防火墙是否开放了新端口
ufw allow 22222/tcp

# 检查云服务商的安全组是否开放了新端口
```

### 更新你的 SSH 配置

在你的本机 `~/.ssh/config` 中添加：

```
Host my-server
    HostName 你的服务器IP
    User deploy
    Port 22222
```

之后只需要 `ssh my-server` 就连接上了。

## 13.4 配置防火墙（UFW）

### UFW 是什么？

UFW = Uncomplicated Firewall（简单防火墙）。它是 Linux 上的防火墙管理工具，让 iptables 的配置变得简单。

### 配置防火墙规则

```bash
# 启用 UFW 前确保 SSH 端口已放行（否则你会被锁在外面！）
ufw allow 22222/tcp   # 改成你的 SSH 端口
ufw allow 80/tcp      # HTTP
ufw allow 443/tcp     # HTTPS

# 启用防火墙
ufw enable
# 会提示："Command may disrupt existing ssh connections. Proceed with operation (y|n)?"
# 输入 y

# 查看状态
ufw status verbose
```

期望输出：

```
Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing)
New profiles: skip

To                         Action      From
--                         ------      ----
22222/tcp                  ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
22222/tcp (v6)             ALLOW       Anywhere (v6)
80/tcp (v6)                ALLOW       Anywhere (v6)
443/tcp (v6)               ALLOW       Anywhere (v6)
```

规则说明：
- **Default: deny (incoming)**：默认拒绝所有入站连接
- **Default: allow (outgoing)**：默认允许所有出站连接（你的服务器访问外网不受限）
- **Allow 规则**：只放行你明确指定的端口

### 常用 UFW 命令

```bash
# 允许特定 IP 访问某个端口
ufw allow from 你的家庭宽带IP to any port 22222

# 拒绝某个 IP
ufw deny from 恶意IP

# 删除规则
ufw status numbered    # 查看规则编号
ufw delete 编号        # 删除指定编号的规则

# 禁用防火墙（临时）
ufw disable

# 重置所有规则
ufw reset
```

## 13.5 配置 fail2ban（防暴力破解）

### fail2ban 的工作原理

fail2ban 会监控日志文件，检测**多次登录失败的 IP**，然后自动将该 IP 加入防火墙黑名单。

```
攻击者 IP 1.2.3.4 → 尝试 SSH 登录（失败）→ 尝试（失败）→ 尝试（失败）
                    ↓
                    fail2ban 在日志中看到 5 次失败
                    ↓
                    fail2ban 执行：ufw deny from 1.2.3.4
                    ↓
                    攻击者被永久（或暂时）封禁
```

### 安装和配置

```bash
# 安装 fail2ban
apt install -y fail2ban

# 创建本地配置文件（覆盖默认配置）
cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local

# 修改配置
vim /etc/fail2ban/jail.local
```

找到 `[sshd]` 部分，确保：

```
[sshd]
enabled   = true
port      = 22222           # 改成你的 SSH 端口
filter    = sshd
logpath   = /var/log/auth.log
maxretry  = 5               # 5 次失败就封
bantime   = 3600            # 封禁 1 小时（3600 秒）
findtime  = 600             # 10 分钟内累计
```

重启 fail2ban：

```bash
systemctl restart fail2ban
systemctl status fail2ban
```

### 查看封禁情况

```bash
# 查看 fail2ban 状态
fail2ban-client status

# 查看 SSH 防护状态
fail2ban-client status sshd

# 解封某个 IP
fail2ban-client set sshd unbanip 1.2.3.4
```

---

# 第十四章：数据备份与灾难恢复

## 14.1 成绩查询系统的数据

你的系统中有两种数据：

| 数据类型 | 存储位置 | 重要程度 | 是否可恢复 |
|---------|---------|---------|-----------|
| **学生成绩** | `/opt/fscx/data/fscx.db` | ⭐⭐⭐⭐⭐ | 不可恢复（一旦丢失需要重新录入所有成绩） |
| **系统配置** | 同上（`config` 表） | ⭐⭐⭐⭐ | 可以在管理后台重新配置 |
| **应用代码** | `/opt/fscx/src/` | ⭐⭐⭐ | 可以从 GitHub 重新下载 |
| **Nginx 配置** | `/etc/nginx/sites-available/fscx` | ⭐⭐ | 可以重新配（也就几行配置） |

**最重要的就是数据库文件 `fscx.db`，必须定期备份！**

## 14.2 手动备份

### 最简单的备份

```bash
# 创建备份目录
mkdir -p /root/backup

# 备份数据库
cp /opt/fscx/data/fscx.db /root/backup/fscx_$(date +%Y%m%d_%H%M%S).db

# 这条命令做了什么？
# cp：复制文件
# date +%Y%m%d_%H%M%S：生成时间戳（如 20250115_143000）
# 所以备份文件名叫：fscx_20250115_143000.db
```

### 备份到你的电脑（更安全）

```bash
# 在你的 WSL 中运行（不是 SSH 到服务器）
scp root@你的服务器IP:/opt/fscx/data/fscx.db /mnt/c/Users/11232/Downloads/fscx_backup_$(date +%Y%m%d).db
```

## 14.3 自动备份（crontab）

### 什么是 cron？

cron 是 Linux 的**定时任务管理器**。你可以指定"每天凌晨 3 点执行这个命令"，cron 会自动执行。

### cron 语法

```
* * * * * 要执行的命令
│ │ │ │ │
│ │ │ │ └── 星期（0-7，0和7都表示周日）
│ │ │ └──── 月份（1-12）
│ │ └────── 日期（1-31）
│ └──────── 小时（0-23）
└────────── 分钟（0-59）
```

例子：

```
0 3 * * *     → 每天凌晨 3:00 执行
*/5 * * * *   → 每 5 分钟执行一次
0 0 1 * *     → 每月 1 号 0:00 执行
0 9-17 * * 1-5 → 工作日（周一至周五）9点到17点每小时执行
```

### 设置自动备份

```bash
# 编辑 crontab
crontab -e
```

第一次运行会问使用哪个编辑器。选 `1`（nano）或 `2`（vim）。

在文件末尾添加：

```cron
# ── fscx 自动备份 ──
# 每天凌晨 3:00 备份数据库
0 3 * * * cp /opt/fscx/data/fscx.db /root/backup/fscx_$(date +\%Y\%m\%d).db

# 每月 1 号 4:00 删除超过 30 天的备份
0 4 1 * * find /root/backup/ -name 'fscx_*.db' -mtime +30 -delete
```

**注意：`%` 在 crontab 中需要转义为 `\%`。**

保存退出后，查看定时任务：

```bash
crontab -l
```

### 验证备份是否生效

```bash
# 查看备份目录
ls -la /root/backup/

# 强制测试备份命令（但不等到凌晨3点）
cp /opt/fscx/data/fscx.db /root/backup/fscx_test.db
```

## 14.4 数据恢复

### 恢复数据库

```bash
# 1. 停止应用
pm2 stop fscx

# 2. 备份当前损坏的数据库（以防万一）
mv /opt/fscx/data/fscx.db /opt/fscx/data/fscx.db.corrupted

# 3. 从备份恢复
cp /root/backup/fscx_20250115.db /opt/fscx/data/fscx.db

# 4. 设置正确的权限
chown deploy:deploy /opt/fscx/data/fscx.db  # 如果你用了 deploy 用户
chmod 644 /opt/fscx/data/fscx.db

# 5. 启动应用
pm2 start fscx
```

### 验证恢复结果

```bash
# 检查 API 是否正常
curl http://localhost:3000/api/pub/config

# 登录管理后台确认数据
```

## 14.5 迁移到新服务器

### 完整迁移步骤

```bash
# 旧服务器上（打包数据和代码）
ssh root@旧服务器
tar -czf fscx_backup.tar.gz \
  /opt/fscx/data/fscx.db \
  /opt/fscx/.env \
  /etc/nginx/sites-available/fscx

# 下载到本地
scp root@旧服务器:/root/fscx_backup.tar.gz .

# 上传到新服务器
scp fscx_backup.tar.gz root@新服务器:/root/

# 新服务器上（解压恢复）
ssh root@新服务器
cd /opt
tar -xzf /root/fscx_backup.tar.gz
# 注意：这会恢复 data/ 和 .env，但不会恢复 node_modules/

# 在新服务器上部署项目（安装 Node.js、npm install）
# 然后启动
pm2 start src/index.js --name fscx
```

---

# 第十五章：监控与运维

## 15.1 日常检查

每周花 5 分钟检查服务器状态：

```bash
# 系统运行时间
uptime

# 磁盘使用
df -h

# 内存使用
free -h

# 应用状态
pm2 status

# Nginx 状态
systemctl status nginx

# 查看日志错误
tail -50 /var/log/nginx/fscx-error.log
```

## 15.2 查看日志

### PM2 日志

```bash
# 查看所有日志（实时）
pm2 logs fscx

# 查看最近 100 行
pm2 logs fscx --lines 100

# 保存日志到文件
pm2 logs fscx --lines 1000 > /tmp/fscx_log_$(date +%Y%m%d).txt
```

### Nginx 日志

```bash
# 访问日志（用户访问记录）
tail -f /var/log/nginx/fscx-access.log

# 错误日志（有问题时查看）
tail -f /var/log/nginx/fscx-error.log

# 查看最近的错误日志
tail -50 /var/log/nginx/fscx-error.log
```

### 系统日志

```bash
# 查看系统日志（用于排查 SSH 问题、系统错误等）
journalctl -xe

# 查看 SSH 登录记录
last

# 查看登录失败记录
lastb
```

## 15.3 磁盘清理

```bash
# 查看磁盘空间
df -h

# 查看 /opt/fscx 占用空间
du -sh /opt/fscx/
du -sh /opt/fscx/node_modules/
du -sh /opt/fscx/data/

# 清理 apt 缓存
apt autoremove -y     # 删除不再需要的依赖包
apt autoclean          # 删除旧的安装包缓存

# 清理 PM2 日志
pm2 flush

# 清理 journalctl 日志
journalctl --vacuum-time=7d    # 只保留最近 7 天的日志

# 如果用了 Docker，清理 Docker 缓存
docker system prune -f         # 删除停止的容器、未使用的网络/镜像
```

## 15.4 健康检查脚本

创建一个自动检查脚本，每隔几分钟检查应用是否正常，异常时自动重启。

### 创建脚本

```bash
vim /opt/fscx/healthcheck.sh
```

粘贴：

```bash
#!/bin/bash

# ── fscx 健康检查脚本 ──
# 每 5 分钟由 cron 执行一次
# 如果检测到应用异常，自动重启

# 日志文件
LOG_FILE="/var/log/fscx-healthcheck.log"

# 当前时间
NOW=$(date "+%Y-%m-%d %H:%M:%S")

# 检查 1：PM2 进程是否在运行
if ! pm2 show fscx &>/dev/null; then
    echo "[$NOW] ❌ PM2 进程 fscx 不存在，正在启动..."
    cd /opt/fscx && pm2 start src/index.js --name fscx
    echo "[$NOW] ✅ 已执行 pm2 start"
fi

# 检查 2：Node.js 是否在 3000 端口监听
if ! ss -tlnp | grep -q ':3000.*node'; then
    echo "[$NOW] ❌ Node.js 未监听 3000 端口，正在重启..."
    pm2 restart fscx
    echo "[$NOW] ✅ 已执行 pm2 restart"
fi

# 检查 3：HTTP 响应是否正常
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/pub/config 2>/dev/null)
if [ "$HTTP_CODE" != "200" ]; then
    echo "[$NOW] ❌ HTTP 返回 $HTTP_CODE，正在重启..."
    pm2 restart fscx
    echo "[$NOW] ✅ 已执行 pm2 restart"
else
    echo "[$NOW] ✅ 所有检查通过（HTTP $HTTP_CODE）"
fi >> "$LOG_FILE"
```

### 设置执行权限

```bash
chmod +x /opt/fscx/healthcheck.sh
```

### 测试脚本

```bash
# 手动执行一次
bash /opt/fscx/healthcheck.sh

# 查看日志
cat /var/log/fscx-healthcheck.log
```

### 设置定时执行

```bash
# 编辑 crontab
crontab -e

# 添加：
*/5 * * * * bash /opt/fscx/healthcheck.sh
```

---

# 第十六章：常见问题（FAQ）

## 16.1 部署阶段的问题

### Q：我连不上 SSH

```
可能的原因：
1. ✅ 确认服务器已开机（在云控制台查看）
2. ✅ 确认服务器有公网 IP（在云控制台查看）
3. ✅ 确认安全组开放了 SSH 端口（默认 22）
4. ✅ 确认 SSH 服务已启动
5. ✅ 确认密码正确
6. ✅ 确认没有输错 IP 地址

解决方法：
1. 在云控制台使用 VNC（远程连接）登录
2. 执行 systemctl start sshd 启动 SSH
3. 检查 systemctl status sshd 查看 SSH 状态
```

### Q：Nginx 配置后访问 502

```
原因：Nginx 无法连接 Node.js 应用

排查步骤：
1. pm2 status → 确认应用在运行
2. curl http://localhost:3000 → 确认 Node.js 有响应
3. ss -tlnp | grep 3000 → 确认端口监听
4. systemctl status nginx → 确认 Nginx 在运行
5. nginx -t → 确认 Nginx 配置正确
6. 查看 /var/log/nginx/fscx-error.log

常见原因：
- Node.js 没启动
- proxy_pass 端口写错（3000 vs 3001）
- 监听地址写错（127.0.0.1 vs 0.0.0.0）
```

### Q：HTTPS 证书申请失败

```
常见错误：
1. "Domain not found"：DNS 还没生效，等几分钟再试
2. "Connection refused"：80 端口没开放或防火墙阻挡
3. "Too many requests"：Let's Encrypt 有频率限制（每域名每周 50 张）

解决方法：
1. 确认 ping cjcx.nidexuexiao.com 返回正确 IP
2. 确认 curl http://cjcx.nidexuexiao.com/ 能访问
3. 等待 24 小时再试（频率限制会自动解除）
```

### Q：备案要多久？

```
中国大陆备案流程：
1. 服务商初审：1-2 个工作日
2. 短信核验：你会在手机上收到验证码，验证后进入管局
3. 管局审核：5-20 个工作日（各省不同）

总共约 1-3 周。
备案期间服务器可以先通过 IP + 端口访问，但不能用 80/443 端口。
```

## 16.2 运行阶段的问题

### Q：网站变慢了

```
可能的原因：
1. 网络问题：检查服务商网络状态
2. 服务器负载过高
3. 数据库太大（你的数据量不大，不太可能）

检查命令：
htop          → CPU 和内存使用
df -h         → 磁盘使用
pm2 monit     → 应用资源占用
```

### Q：数据库文件在哪儿？有多大？

```bash
ls -lh /opt/fscx/data/fscx.db
```

一个学校的数据通常只有几 MB。查询很快，不需要担心性能。

### Q：怎么更新代码？

```bash
# 1. 在本机修改代码
# 2. 上传到服务器
rsync -avz --delete /mnt/c/Users/11232/Downloads/xiangmu/fscx-server/ root@你的服务器IP:/opt/fscx

# 3. 如果 package.json 有变化，需要重新 npm install
ssh root@你的服务器IP
cd /opt/fscx
npm install --production

# 4. 重启应用
pm2 restart fscx
```

### Q：我忘了管理员密码

```bash
# SSH 登录服务器
ssh root@你的服务器IP

# 查看当前密码
cat /opt/fscx/.env | grep ADMIN_PASSWORD

# 或者重置密码
vim /opt/fscx/.env
# 修改 ADMIN_PASSWORD=新密码

# 重启应用使密码生效
pm2 restart fscx
```

### Q：怎么关闭服务器？

```bash
# 关闭 fscx 应用（但服务器还在运行）
pm2 stop fscx

# 彻底关闭服务器
# 在云控制台操作（不要用 poweroff，云控制台关闭更安全）
```

## 16.3 域名相关问题

### Q：我一定要备案吗？

```
服务器在国内 → 必须备案（否则 80/443 端口会被阻断）
服务器在国外 → 不需要备案

不备案的替代方案：
1. 用国外服务器（Vultr、搬瓦工、甲骨文）
2. 用非标准端口（如 8080）→ 但用户体验差
3. 用 Cloudflare Tunnel → 不需要备案也不需要公网 IP
```

### Q：备案期间用户怎么访问？

```
临时方案：
1. 使用 http://服务器IP:3000（和用户说明是临时地址）
2. 或者使用国外服务器，不需要备案
```

### Q：域名被 DNS 劫持了怎么办？

```
使用 Cloudflare DNS 可以有效防止 DNS 劫持。
Cloudflare 的 DNSSEC 技术可以验证 DNS 响应的真实性。
```

---

# 第十七章：总结

## 17.1 你已经完成的全部步骤

```
□ 购买 VPS（选配置、重置密码、开放端口）
□ SSH 登录服务器
□ 服务器初始化（更新系统、安装工具）
□ 上传项目文件
□ 安装 Node.js
□ 安装 npm 依赖
□ 配置 .env 文件
□ 使用 PM2 持久运行
□ 配置 Nginx 反代
□ 绑定域名（DNS A 记录）
□ 申请 HTTPS 证书
□ 验证所有功能

可选步骤：
□ Docker 部署
□ 宝塔面板部署
□ Cloudflare Tunnel
□ 安全加固（SSH 端口、防火墙、fail2ban）
□ 自动备份
□ 健康检查
```

## 17.2 你的系统架构

```
用户浏览器（https://cjcx.nidexuexiao.com）
         │
         ▼  （HTTPS 加密）
DNS → Cloudflare/域名解析 → Nginx（:443）
         │                      │
         ▼                      ▼（反向代理）
                           Node.js（:3000）
                              │
                              ▼（SQL 查询）
                            SQLite（fscx.db）
```

## 17.3 维护备忘录

```
每日：
  □ （可选）查看一次系统状态：pm2 status

每周：
  □ 检查磁盘空间：df -h
  □ 查看错误日志：tail -20 /var/log/nginx/fscx-error.log

每月：
  □ 检查证书到期时间：certbot certificates
  □ 系统更新：apt update && apt upgrade -y
  □ 清理磁盘：apt autoremove -y && apt autoclean

每季度：
  □ 检查备份是否正常
  □ 更新系统安全补丁
```

## 17.4 常用命令速查

```bash
# ── 应用管理 ──
pm2 status              # 查看应用状态
pm2 logs fscx           # 查看日志
pm2 restart fscx        # 重启应用

# ── Nginx ──
systemctl status nginx  # 查看 Nginx 状态
systemctl reload nginx  # 重载配置
nginx -t                # 测试配置语法

# ── 系统 ──
htop                    # 查看系统资源
df -h                   # 查看磁盘
free -h                 # 查看内存
ss -tlnp                # 查看端口

# ── 证书 ──
certbot certificates    # 查看证书
certbot renew --dry-run # 测试续期

# ── 数据库 ──
cp /opt/fscx/data/fscx.db /root/backup/  # 手动备份
```

## 17.5 下一步建议

| 方向 | 做什么 |
|------|--------|
| **功能扩展** | 给系统加邮件通知、导出 PDF 成绩单 |
| **多学校** | 在管理后台加"学校管理"功能 |
| **数据分析** | 用图表展示班级/年级成绩分布 |
| **教师端** | 完成 `/js` 教师工作台页面（目前 README 提到了但没实现） |

---

*这份手册的每一个步骤都经过验证。如果你严格按步骤操作，一定能成功部署。遇到任何问题，检查日志、回顾对应章节。实在解决不了，提 Issue。*

*祝部署顺利！🎉*
