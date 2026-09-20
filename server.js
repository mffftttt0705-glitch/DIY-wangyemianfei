const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 生产环境信任代理（Render / Railway 需要）
app.set('trust proxy', 1);

// 中间件
app.use(cors({ origin: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 数据文件路径（Render 免费版磁盘会重启清空，可接受；如需持久化可换数据库）
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'projects-data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('读取数据失败:', e.message);
  }
  return { projects: {} };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('保存数据失败:', e.message);
    throw e;
  }
}

// ==================== API ====================

// 健康检查（部署平台用来探测服务是否存活）
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    service: 'diy-webpage-platform'
  });
});

// 获取已发布的公开项目列表
app.get('/api/projects', (req, res) => {
  try {
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
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 保存 / 更新项目（无需登录）
app.post('/api/projects', (req, res) => {
  try {
    const { id, title, html, clientId } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: '标题不能为空' });
    }
    if (html === undefined || html === null) {
      return res.status(400).json({ error: '内容不能为空' });
    }
    if (String(html).length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'HTML 内容过大（最大约 4MB）' });
    }

    const data = loadData();
    const now = new Date().toISOString();
    const projectId = id || uuidv4();

    const existing = data.projects[projectId] || {};
    data.projects[projectId] = {
      id: projectId,
      title: title.trim().slice(0, 100),
      html: String(html),
      clientId: clientId || existing.clientId || 'anonymous',
      slug: existing.slug || null,
      is_published: existing.is_published || false,
      created_at: existing.created_at || now,
      updated_at: now
    };
    saveData(data);
    res.json({
      id: projectId,
      title: data.projects[projectId].title,
      updated_at: now
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '保存失败' });
  }
});

// 发布项目（生成公开链接 /p/slug）
app.post('/api/projects/:id/publish', (req, res) => {
  try {
    const { slug } = req.body;
    if (!slug || !/^[a-z0-9-]{3,30}$/.test(slug)) {
      return res.status(400).json({
        error: 'slug 只能包含小写字母、数字和短横线，长度 3-30'
      });
    }

    const data = loadData();
    const project = data.projects[req.params.id];
    if (!project) {
      return res.status(404).json({ error: '项目不存在，请先保存' });
    }

    const occupied = Object.values(data.projects).find(
      p => p.slug === slug && p.id !== req.params.id
    );
    if (occupied) {
      return res.status(400).json({ error: '该发布地址已被占用，请换一个' });
    }

    project.slug = slug;
    project.is_published = true;
    project.updated_at = new Date().toISOString();
    saveData(data);

    res.json({
      success: true,
      url: `/p/${slug}`,
      fullUrl: `${req.protocol}://${req.get('host')}/p/${slug}`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '发布失败' });
  }
});

// 取消发布
app.post('/api/projects/:id/unpublish', (req, res) => {
  try {
    const data = loadData();
    const project = data.projects[req.params.id];
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }
    project.is_published = false;
    project.updated_at = new Date().toISOString();
    saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '操作失败' });
  }
});

// 公开访问已发布页面
app.get('/p/:slug', (req, res) => {
  try {
    const data = loadData();
    const project = Object.values(data.projects).find(
      p => p.slug === req.params.slug && p.is_published
    );

    if (!project) {
      return res.status(404).send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>页面不存在</title>
</head>
<body style="font-family:system-ui;text-align:center;padding:80px;background:#0f172a;color:#e2e8f0;">
  <h1 style="font-size:48px;margin-bottom:12px;">404</h1>
  <p>该页面不存在或尚未发布</p>
  <p style="margin-top:24px;"><a href="/" style="color:#60a5fa;">返回首页</a></p>
</body>
</html>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(project.html);
  } catch (e) {
    res.status(500).send('服务器错误');
  }
});

// 前端路由兜底（刷新时不 404）
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/p/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DIY 网页平台已启动 → http://0.0.0.0:${PORT}`);
  console.log(`健康检查: /api/health`);
  console.log(`公开页面: /p/你的slug`);
});
