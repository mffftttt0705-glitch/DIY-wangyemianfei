const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 简单的内存 + 文件存储（无需登录）
const DATA_FILE = path.join(__dirname, 'projects-data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return { projects: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 获取所有公开项目列表（可选）
app.get('/api/projects', (req, res) => {
  const data = loadData();
  const list = Object.values(data.projects)
    .filter(p => p.is_published)
    .map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      updated_at: p.updated_at
    }));
  res.json(list);
});

// 保存/更新项目（无需登录，用本地生成的 clientId）
app.post('/api/projects', (req, res) => {
  const { id, title, html, clientId } = req.body;
  if (!title || !html) {
    return res.status(400).json({ error: '标题和内容不能为空' });
  }
  const data = loadData();
  const now = new Date().toISOString();
  const projectId = id || uuidv4();

  data.projects[projectId] = {
    id: projectId,
    title: title.trim(),
    html,
    clientId: clientId || 'anonymous',
    slug: data.projects[projectId]?.slug || null,
    is_published: data.projects[projectId]?.is_published || false,
    created_at: data.projects[projectId]?.created_at || now,
    updated_at: now
  };
  saveData(data);
  res.json({ id: projectId, title: title.trim(), updated_at: now });
});

// 发布项目（生成公开链接）
app.post('/api/projects/:id/publish', (req, res) => {
  const { slug } = req.body;
  if (!slug || !/^[a-z0-9-]{3,30}$/.test(slug)) {
    return res.status(400).json({ error: 'slug 只能包含小写字母、数字和短横线，长度 3-30' });
  }
  const data = loadData();
  const project = data.projects[req.params.id];
  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }
  // 检查 slug 是否被占用
  const occupied = Object.values(data.projects).find(p => p.slug === slug && p.id !== req.params.id);
  if (occupied) {
    return res.status(400).json({ error: '该发布地址已被占用' });
  }
  project.slug = slug;
  project.is_published = true;
  project.updated_at = new Date().toISOString();
  saveData(data);
  res.json({ success: true, url: `/p/${slug}` });
});

// 取消发布
app.post('/api/projects/:id/unpublish', (req, res) => {
  const data = loadData();
  const project = data.projects[req.params.id];
  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }
  project.is_published = false;
  project.updated_at = new Date().toISOString();
  saveData(data);
  res.json({ success: true });
});

// 公开访问已发布页面
app.get('/p/:slug', (req, res) => {
  const data = loadData();
  const project = Object.values(data.projects).find(p => p.slug === req.params.slug && p.is_published);
  if (!project) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head><meta charset="UTF-8"><title>页面不存在</title></head>
      <body style="font-family:system-ui;text-align:center;padding:80px;background:#0f172a;color:#e2e8f0;">
        <h1>404</h1>
        <p>该页面不存在或尚未发布</p>
      </body>
      </html>
    `);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(project.html);
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`DIY 网页平台已启动: http://localhost:${PORT}`);
  console.log(`无需登录即可使用全部功能`);
});
