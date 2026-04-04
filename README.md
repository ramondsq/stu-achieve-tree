# 学习进度成就树系统

当前项目已迁移为微信云开发 CloudBase 架构，不再依赖 Vercel、Supabase、Cloudflare Pages，仓库中的旧本地 Express 参考链路也已移除。

## 当前部署架构

- 静态网站托管：老师后台和学生 Web 演示页直接上传 `public/` 目录到 CloudBase Static Hosting
- 云函数：`api`
- 小程序端：`wx.cloud.callFunction` 调用 `api`
- Web 端：CloudBase Web SDK 匿名登录后调用 `api`
- 文档型数据库：CloudBase NoSQL
- 附件存储：独立 COS 对象存储（通过云函数上传、签名下载、删除）

当前环境：

- `EnvId`: `cloud1-7gu74gqqd2913ea4`
- `Region`: `ap-shanghai`
- 静态托管域名：`http://cloud1-7gu74gqqd2913ea4-1408652187.tcloudbaseapp.com/`
- 云函数名：`api`

## 目录说明

- `cloudfunctions/api/`
  CloudBase 云函数主后端，承接老师后台、学生 Web、小程序的全部业务接口
- `miniprogram/`
  微信小程序代码，已切换到 `wx.cloud`
- `project.config.json`
  微信开发者工具的唯一项目入口，统一映射 `miniprogram/` 和 `cloudfunctions/`
- `public/`
  静态托管页面，直接作为 CloudBase Static Hosting 上传目录

## 数据集合

当前 CloudBase NoSQL 集合：

- `achv_teachers`
- `achv_students`
- `achv_learning_trees`
- `achv_knowledge_nodes`
- `achv_student_scores`
- `achv_student_node_submissions`
- `achv_share_cards`

当前建议保持的关键二级索引：

- `achv_teachers.username_unique`
- `achv_students.username_unique`
- `achv_students.wechat_openid_unique`
- `achv_knowledge_nodes.tree_parent_sort`
- `achv_knowledge_nodes.parent_id`
- `achv_student_scores.student_node_unique`
- `achv_student_node_submissions.student_node_submitted_at`

补充说明：

- `achv_knowledge_nodes.parent_id` 用于叶子节点校验等直接按 `parent_id` 查询的场景。
- `achv_share_cards` 当前只通过文档 `_id` 读取详情，暂不依赖额外二级索引。

权限策略：

- 上述所有集合：`ADMINONLY`
- 云存储桶：`PRIVATE`

也就是说，页面和小程序不会直接访问数据库或存储，统一经过云函数。

## 接口概览

云函数 `api` 兼容原有业务接口路径，主要包括：

- 老师认证
  - `POST /api/teacher/login`
  - `POST /api/teacher/logout`
  - `GET /api/teacher/me`
- 学生管理
  - `GET /api/students`
  - `POST /api/students`
  - `PUT /api/students/:id`
  - `DELETE /api/students/:id`
- 学习树管理
  - `GET /api/trees`
  - `GET /api/system-tree-settings`
  - `POST /api/trees`
  - `PUT /api/trees/:id`
  - `DELETE /api/trees/:id`
  - `GET /api/trees/:treeId/nodes`
  - `POST /api/trees/:treeId/nodes`
  - `PUT /api/nodes/:id`
  - `DELETE /api/nodes/:id`
- 评分与提交
  - `GET /api/scores`
  - `PUT /api/scores`
  - `DELETE /api/scores`
  - `GET /api/submissions`
  - `PUT /api/submissions/:id/score`
- 学生端
  - `POST /api/student/login`
  - `POST /api/student/logout`
  - `GET /api/student/me`
  - `GET /api/student/trees`
  - `POST /api/student/node-submissions`
  - `POST /api/student/wechat-bind`
  - `POST /api/student/wechat-login`

## 鉴权说明

### Web 端

- 静态页通过 `https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js` 初始化 CloudBase Web SDK
- 使用匿名登录拿到 CloudBase 会话
- 再通过 `callFunction({ name: 'api' })` 调业务云函数
- 老师/学生业务登录仍然沿用项目自己的签名 token，保存在浏览器 `localStorage`

### 小程序端

- `miniprogram/app.js` 已初始化：
  - `env: cloud1-7gu74gqqd2913ea4`
- 业务接口统一走：
  - `wx.cloud.callFunction({ name: 'api' })`
- 微信绑定/登录不再依赖 `wx.login + jscode2session`
- 云函数内直接通过 `cloud.getWXContext().OPENID` 获取当前小程序用户身份

## 静态页配置

`public/cloudbase-config.js` 已写入：

- `envId`
- `region`
- `publishableKey`

如果后续更换环境，需要同步修改这个文件并重新上传静态资源。

## 环境切换同步点

如果后续切换 CloudBase 环境，至少同步以下文件：

- `cloudbaserc.json`
  部署清单中的 `envId`、`region`、`hostingRoot`、云函数/集合列表
- `public/cloudbase-config.js`
  Web 端调用云函数所需的 `envId`、`region`、`publishableKey`
- `miniprogram/app.js`
  小程序 `wx.cloud.init` 使用的 `env`，以及 PDF 预览页静态托管地址
- `README.md`
  当前环境摘要、静态托管域名与 CloudBase 控制台入口

## COS 附件存储配置

当前版本已经把题目附件和学生提交附件切到独立 COS，对应云函数 `api` 需要配置以下环境变量：

- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_SESSION_TOKEN`（可选，使用临时密钥时配置）
- `COS_BUCKET`
- `COS_REGION`
- `COS_URL_EXPIRES_SECONDS`（可选，默认 `3600`）

说明：

- 新上传附件会写入独立 COS，不再占用 CloudBase 文件存储。
- 旧的 CloudBase 文件记录仍然兼容读取，后续可逐步清理。
- COS 桶建议使用私有读，页面和小程序通过云函数生成签名地址访问。

## 小程序说明

已完成的切换：

- `miniprogram/app.js` 改为 `wx.cloud.init`
- `miniprogram/utils/request.js` 改为 `wx.cloud.callFunction`
- 登录页去掉 `wx.login` 依赖
- 根目录 `project.config.json` 已设置：
  - `miniprogramRoot: "miniprogram/"`
  - `cloudfunctionRoot: "cloudfunctions/"`

建议在微信开发者工具中执行：

1. 导入仓库根目录
2. 确认 AppID 正确
3. 右键 `cloudfunctions/api`，执行“云端安装依赖”
4. 如遇权限或依赖问题，再用开发者工具手动上传一次云函数

## CloudBase 维护入口

- 概览  
  `https://tcb.cloud.tencent.com/dev?envId=cloud1-7gu74gqqd2913ea4#/overview`
- 云函数  
  `https://tcb.cloud.tencent.com/dev?envId=cloud1-7gu74gqqd2913ea4#/scf`
- 文档型数据库  
  `https://tcb.cloud.tencent.com/dev?envId=cloud1-7gu74gqqd2913ea4#/db/doc`
- 云存储  
  `https://tcb.cloud.tencent.com/dev?envId=cloud1-7gu74gqqd2913ea4#/storage`
- 静态网站托管  
  `https://tcb.cloud.tencent.com/dev?envId=cloud1-7gu74gqqd2913ea4#/static-hosting`

## 已完成的迁移项

- 将后端主逻辑迁移到 `cloudfunctions/api/index.js`
- 将数据存储从 SQLite / Postgres / Supabase 改为 CloudBase NoSQL + 独立 COS 附件存储
- 将学生小程序请求链迁移到 `wx.cloud`
- 将老师后台和学生 Web 演示迁移到 CloudBase Web SDK + 云函数
- 将静态资源部署到 CloudBase Static Hosting
- 为老师后台补充系统树详细设置面板，可查看知识点树/每周悬赏树的固定规则、阈值和系统节点明细
- 清理旧的 Vercel / Cloudflare Pages 代理与部署脚本，收敛为 CloudBase 单一正式链路
- 收敛微信开发者工具配置为根目录单一入口，避免 `project.config.json` 重复漂移
- 移除根目录旧的 Express / Supabase / Postgres 本地参考链路与相关依赖清单

## 系统树规则

当前项目内置两棵系统树，都会在初始化阶段自动创建：

- `C++知识点树`
  - 固定 `systemKey`: `cpp_algorithm_tree`
  - 用于学生等级结算
  - 当带 `milestoneLevel` 的系统节点完成度达到 `80%` 时，学生升级到对应等级
- `每周悬赏树`
  - 固定 `systemKey`: `weekly_bounty_tree`
  - 叶子任务点按 `requiredLevel` 与学生等级逐级解锁
  - 当整棵树完成度达到 `80%` 时，学生获得 `+1` 积分，且每名学生只发放一次

老师后台“系统树详细设置”面板和接口 `GET /api/system-tree-settings` 都直接读取这套后端规则，而不是前端单独维护说明文本。

## 当前边界

- 老师账号仍然是单管理员模式，没有老师 CRUD 页面
- 当前仓库默认只维护 CloudBase 正式链路，若需要新的测试入口，建议直接围绕 `cloudfunctions/api` 或页面端补充测试
