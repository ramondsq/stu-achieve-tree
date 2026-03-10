# 学习进度成就树系统

当前项目已迁移为微信云开发 CloudBase 架构，不再依赖 Vercel、Supabase 或 Cloudflare Pages 作为正式部署方案。

## 当前部署架构

- 静态网站托管：老师后台和学生 Web 演示页部署到 CloudBase Static Hosting
- 云函数：`api`
- 小程序端：`wx.cloud.callFunction` 调用 `api`
- Web 端：CloudBase Web SDK 匿名登录后调用 `api`
- 文档型数据库：CloudBase NoSQL
- 图片存储：CloudBase 云存储（私有桶，通过云函数生成临时访问地址）

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
- `public/`
  静态托管页面
- `server.js`
  旧版 Express 服务，保留作历史参考，不再作为 CloudBase 正式部署入口

## 数据集合

当前 CloudBase NoSQL 集合：

- `achv_teachers`
- `achv_students`
- `achv_learning_trees`
- `achv_knowledge_nodes`
- `achv_student_scores`
- `achv_student_node_submissions`

已创建的关键索引：

- `achv_teachers.username_unique`
- `achv_students.username_unique`
- `achv_students.wechat_openid_unique`
- `achv_knowledge_nodes.tree_parent_sort`
- `achv_student_scores.student_node_unique`
- `achv_student_node_submissions.student_node_submitted_at`

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

## 小程序说明

已完成的切换：

- `miniprogram/app.js` 改为 `wx.cloud.init`
- `miniprogram/utils/request.js` 改为 `wx.cloud.callFunction`
- 登录页去掉 `wx.login` 依赖
- `project.config.json` 已设置 `cloudfunctionRoot: "../cloudfunctions"`

建议在微信开发者工具中执行：

1. 导入 `miniprogram/`
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
- 将数据存储从 SQLite / Postgres / Supabase 改为 CloudBase NoSQL + 云存储
- 将学生小程序请求链迁移到 `wx.cloud`
- 将老师后台和学生 Web 演示迁移到 CloudBase Web SDK + 云函数
- 将静态资源部署到 CloudBase Static Hosting

## 当前边界

- 老师账号仍然是单管理员模式，没有老师 CRUD 页面
- `server.js`、`vercel.json`、`scripts/deploy-vercel.sh` 等旧文件还在仓库中，但已不属于 CloudBase 正式链路
- 如需彻底清理旧技术栈，可以继续删掉 Express / Supabase / Vercel 相关文件和依赖
