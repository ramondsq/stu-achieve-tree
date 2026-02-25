# 少儿编程学习进度成就树系统（MVP）

这是一个可直接运行的基础版本，包含：

- 老师后台网页版（用户名/密码登录）
- 学习树（章节）管理：增删改查
- 知识点节点管理：增删改查（树结构，根节点 + 子节点）
- 学生管理：增删改查
- 评分管理：老师对每个学生的每个知识点录入评分/评语（增删改查）
- 学生端接口：账号登录、查询自己的学习树和评分
- 学生节点作业：每个知识点可多次提交代码（文本/图片）
- 微信小程序授权登录接口：`wechat-bind` / `wechat-login`
- 学生微信小程序基础代码（登录/绑定/学习树展示）

## 1. 技术选型

- 后端：Node.js + Express
- 数据库：
  - 本地开发：SQLite（本地文件 `data/app.db`）
  - 生产部署：Supabase Postgres（通过 `DATABASE_URL`）
- 对象存储（代码图片）：Supabase Storage
- 前端：原生 HTML/CSS/JS（老师后台 + 学生 Web 演示页）

## 2. 启动方式

```bash
cp .env.example .env
npm install
npm start
```

说明：
- 本地不填 `DATABASE_URL` 时，默认使用 SQLite。
- 生产部署建议必须配置 `DATABASE_URL`（Supabase Postgres）。

启动后访问：

- 老师后台：`http://localhost:3000/teacher.html`
- 学生端 Web 演示：`http://localhost:3000/student.html`

首次启动会自动创建默认老师账号：

- 用户名：`admin`
- 密码：`admin123`

## 3. 数据模型

### teachers（老师）
- `id`
- `username`（唯一）
- `password_hash`

### students（学生）
- `id`
- `username`（唯一）
- `password_hash`
- `name`
- `wechat_openid`（唯一，可空）

### learning_trees（学习树/章节）
- `id`
- `title`
- `chapter_desc`

### knowledge_nodes（知识点节点）
- `id`
- `tree_id`
- `parent_id`（根节点为 `NULL`）
- `name`
- `sort_order`

说明：每棵树只允许一个根节点（通过唯一索引约束）。

### student_scores（学生知识点评分）
- `id`
- `student_id`
- `node_id`
- `score`
- `comment`
- `updated_at`

说明：`(student_id, node_id)` 唯一，使用 upsert 覆盖更新。

### student_node_submissions（学生节点代码提交记录）
- `id`
- `student_id`
- `node_id`
- `code_text`
- `code_image_url`
- `submitted_at`
- `teacher_score`
- `teacher_comment`
- `scored_at`

说明：同一学生在同一节点可提交多次；老师可按每次提交单独批改。

## 4. 核心接口

### 老师认证
- `POST /api/teacher/login`
- `POST /api/teacher/logout`
- `GET /api/teacher/me`

### 学生管理（老师权限）
- `GET /api/students`
- `POST /api/students`
- `PUT /api/students/:id`
- `DELETE /api/students/:id`

### 学习树与节点（老师权限）
- `GET /api/trees`
- `POST /api/trees`
- `PUT /api/trees/:id`
- `DELETE /api/trees/:id`
- `GET /api/trees/:treeId/nodes`
- `POST /api/trees/:treeId/nodes`
- `PUT /api/nodes/:id`
- `DELETE /api/nodes/:id`

### 评分（老师权限）
- `GET /api/scores?studentId=1&treeId=1`
- `PUT /api/scores`
- `DELETE /api/scores?studentId=1&nodeId=2`
- `GET /api/submissions?studentId=1&treeId=1`（查看该学生在该章节的每次提交）
- `PUT /api/submissions/:id/score`（对某一次提交单独评分/评语）

说明：
- `GET /api/scores` 返回每个节点“最新一次提交”与提交次数
- 老师后台支持按“每次提交”独立批改

### 学生端
- `POST /api/student/login`
- `POST /api/student/logout`
- `GET /api/student/me`
- `GET /api/student/trees`
- `POST /api/student/node-submissions`（新增一次代码提交，可重复提交）

说明：
- 图片支持 `PNG/JPEG/WEBP`，单张最大 `5MB`
- 每次提交可仅文本、仅图片，或文本+图片
- `GET /api/student/trees` 返回每个节点的历史提交记录、最高分与平均分（基于老师对每次提交的评分）

### 微信小程序授权
- `POST /api/student/wechat-bind`
  - 用途：先用账号密码验证学生身份，再绑定 `openid`
- `POST /api/student/wechat-login`
  - 用途：已绑定后，直接用 `code` 登录

## 5. 微信小程序接入说明

本仓库已包含小程序代码目录：`miniprogram/`

### 5.1 在微信开发者工具中运行

1. 打开微信开发者工具，导入 `miniprogram/` 目录。
2. 修改 `miniprogram/app.js` 里的 `globalData.apiBaseUrl` 为你的后端地址。
3. 选择页面 `pages/login/login` 作为入口，先进行账号登录或微信绑定。
4. 登录成功后会跳到 `pages/trees/trees` 展示学习树与评分。

注意：

- 小程序正式环境必须使用公网 `HTTPS` 域名，不能用 `localhost`。
- 开发调试可在开发者工具中临时关闭域名校验（仅开发阶段）。

### 5.2 小程序页面说明

- `pages/login/login`：账号登录、微信登录、微信绑定并登录
- `pages/trees/trees`：每棵学习树默认收起，点击展开后查看节点详情；章节显示总分与平均分；分数按区间着色（0-3 红、4-6 黄、7-10 绿）；每个节点展示历史提交记录，并显示所有提交记录的最高分与平均分

服务端需要配置环境变量：

- `WECHAT_APPID`
- `WECHAT_SECRET`

小程序端典型流程：

1. 调用 `wx.login()` 获取 `code`
2. 首次绑定：调用 `POST /api/student/wechat-bind`，传 `code + username + password`
3. 后续登录：调用 `POST /api/student/wechat-login`，仅传 `code`
4. 服务端返回 `token` 后，小程序请求其他学生接口时加：
   - `Authorization: Bearer <token>`

## 6. 当前版本边界（MVP）

- 老师账号管理目前仅内置默认管理员账号（可后续补老师 CRUD）
- 前端为基础管理台，便于快速验证业务闭环
- 认证已改为无状态签名 token（依赖 `APP_SECRET`）

## 7. 部署到 Vercel + Cloudflare Pages（生产）

### 7.1 准备 Supabase

1. 在 Supabase 创建项目。
2. 获取数据库连接串（`DATABASE_URL`）。
3. 新建 Storage Bucket：`code-images`（或自定义并配置 `SUPABASE_STORAGE_BUCKET`）。
4. 建议将该 Bucket 配置为公开读取（便于老师/学生直接预览代码图片）。

### 7.2 部署到 Vercel（后端主站）

1. 将仓库导入 Vercel。
2. Vercel 会读取仓库内 `vercel.json`，通过 `server.js` 启动 API + 后台页面。
3. 在 Vercel 项目环境变量中配置（至少）：
   - `APP_SECRET`
   - `DATABASE_URL`
   - `DB_SSL=true`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_STORAGE_BUCKET`
4. 首次启动会自动建表并初始化默认老师账号。

可选（CLI）：
```bash
./scripts/deploy-vercel.sh
```

### 7.3 部署到 Cloudflare Pages（同域镜像）

1. Cloudflare Pages 连接同一个仓库。
2. Build 设置：
   - Build command：留空
   - Build output directory：`public`
   - Functions directory：`functions`
3. 在 Cloudflare Pages 环境变量中配置：
   - `VERCEL_BACKEND_URL=https://你的-vercel-域名`
4. `functions/api/[[path]].js` 会将 `/api/*` 请求代理到 Vercel 后端。

可选（CLI）：
```bash
./scripts/deploy-cloudflare-pages.sh <你的-pages-项目名>
```

### 7.4 关键说明

- 你将得到两个可访问域名：
  - Vercel 域名（原生后端）
  - Cloudflare Pages 域名（静态资源 + `/api` 代理）
- 若要完全独立双活（两边各自直接连数据库执行后端逻辑），需要再做 Cloudflare Workers 原生适配，这版先用代理方案快速上线。

## 8. 建议下一步迭代

1. 把老师后台改成 Vue/React + 组件化树图（例如 mind map 渲染）
2. 增加班级/课程维度（同一学生跨班级多套树）
3. 增加评分历史（不是覆盖写入，而是保留版本）
4. 上线前改成 JWT + 刷新机制 + HTTPS + 审计日志
