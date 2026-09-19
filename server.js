const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'diy-webpage-secret-change-me-in-production';

// 中间件
app.use(cors());
app.use(express.json({ limit: '5mb' })); // 允许较大的 HTML
app.use(express.static(path.join(__dirname, 'public'))); // 前端静态文件

// 初始化数据库
const db = new Database('diy-webpage.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    slug TEXT UNIQUE,
    html TEXT NOT NULL DEFAULT '',
    is_published INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// JWT 验证中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ==================== 用户相关 ====================

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度需 3-20 位' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const id = uuidv4();
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)').run(id, username, hashed);

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username, id });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, id: user.id });
});

// 获取当前用户信息
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

// ==================== 项目相关 ====================

// 获取我的所有项目
app.get('/api/projects', authMiddleware, (req, res) => {
  const projects = db.prepare(`
    SELECT id, title, slug, is_published, created_at, updated_at
    FROM projects
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.id);
  res.json(projects);
});

// 创建新项目
app.post('/api/projects', authMiddleware, (req, res) => {
  const { title, html } = req.body;
  if (!title || title.trim().length === 0) {
    return res.status(400).json({ error: '项目标题不能为空' });
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO projects (id, user_id, title, html, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, title.trim(), html || '', now, now);

  res.json({ id, title: title.trim() });
});

// 获取单个项目详情
app.get('/api/projects/:id', authMiddleware, (req, res) => {
  const project = db.prepare(`
    SELECT * FROM projects WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }
  res.json(project);
});

// 更新项目（保存代码 / 改标题）
app.put('/api/projects/:id', authMiddleware, (req, res) => {
  const { title, html } = req.body;
  const project = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);

  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }

  const now = new Date().toISOString();
  if (title !== undefined) {
    db.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.trim(), now, req.params.id);
  }
  if (html !== undefined) {
    db.prepare('UPDATE projects SET html = ?, updated_at = ? WHERE id = ?')
      .run(html, now, req.params.id);
  }

  res.json({ success: true, updated_at: now });
});

// 删除项目
app.delete('/api/projects/:id', authMiddleware, (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '项目不存在' });
  }
  res.json({ success: true });
});

// 发布 / 取消发布
app.post('/api/projects/:id/publish', authMiddleware, (req, res) => {
  const { slug, publish } = req.body; // publish: true/false
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);

  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }

  if (publish) {
    if (!slug || !/^[a-z0-9-]{3,30}$/.test(slug)) {
      return res.status(400).json({ error: 'slug 只能包含小写字母、数字和短横线，长度 3-30' });
    }
    // 检查 slug 是否被占用
    const exists = db.prepare('SELECT id FROM projects WHERE slug = ? AND id != ?').get(slug, req.params.id);
    if (exists) {
      return res.status(400).json({ error: '该发布地址已被占用' });
    }
    db.prepare('UPDATE projects SET slug = ?, is_published = 1, updated_at = ? WHERE id = ?')
      .run(slug, new Date().toISOString(), req.params.id);
    res.json({ success: true, url: `/p/${slug}` });
  } else {
    db.prepare('UPDATE projects SET is_published = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), req.params.id);
    res.json({ success: true });
  }
});

// ==================== 公开访问已发布页面 ====================
app.get('/p/:slug', (req, res) => {
  const project = db.prepare(`
    SELECT html, title FROM projects WHERE slug = ? AND is_published = 1
  `).get(req.params.slug);

  if (!project) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><title>页面不存在</title></head>
      <body style="font-family:system-ui;text-align:center;padding:80px;">
        <h1>404</h1>
        <p>该页面不存在或尚未发布</p>
      </body>
      </html>
    `);
  }

  // 直接返回用户写的 HTML
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(project.html);
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 启动
app.listen(PORT, () => {
  console.log(`DIY 网页平台后端已启动: http://localhost:${PORT}`);
  console.log(`公开页面示例: http://localhost:${PORT}/p/你的slug`);
});