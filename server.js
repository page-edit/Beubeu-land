// ============================================================
// Beubeuland - Backend partage (Render)
// Role : recevoir les uploads video, les stocker sur Cloudflare R2,
// et mettre a jour videos.json sur GitHub (source de verite commune
// que TOUS les visiteurs lisent au chargement du feed).
// ============================================================

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors()); // le feed doit etre lisible/postable depuis n'importe quel visiteur du site
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB, aligne avec la limite cote client
});

const {
  GITHUB_TOKEN,          // Personal Access Token avec droit d'ecriture sur le repo
  GITHUB_OWNER,          // ex: page-edit
  GITHUB_REPO,           // ex: Beubeu-land
  GITHUB_BRANCH = 'main',
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_BASE_URL,    // ex: https://pub-xxxxxxxx.r2.dev  (SANS slash final)
  PORT = 3000
} = process.env;

function assertEnv() {
  const required = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_BASE_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('⚠️  Variables d\'environnement manquantes :', missing.join(', '));
  }
}
assertEnv();

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

const GITHUB_CONTENTS_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/videos.json`;

async function getVideosFile() {
  const res = await fetch(`${GITHUB_CONTENTS_URL}?ref=${GITHUB_BRANCH}`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json'
    }
  });
  if (res.status === 404) return { videos: [], sha: null };
  if (!res.ok) throw new Error('Erreur lecture GitHub (' + res.status + ')');
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  let videos = [];
  try { videos = JSON.parse(content); } catch (e) { videos = []; }
  return { videos, sha: data.sha };
}

async function saveVideosFile(videos, sha, message) {
  const content = Buffer.from(JSON.stringify(videos, null, 2)).toString('base64');
  const body = { message, content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(GITHUB_CONTENTS_URL, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Erreur ecriture GitHub (' + res.status + '): ' + err);
  }
  return res.json();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Upload d'une video (client normal ou admin) ----
app.post('/api/videos', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu' });

    const { title, description, authorId, authorName, isAdmin } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Titre requis' });

    const safeName = (req.file.originalname || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `videos/${Date.now()}-${safeName}`;

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'video/mp4'
    }));

    const videoUrl = `${R2_PUBLIC_BASE_URL}/${key}`;

    const newVideo = {
      id: Date.now(),
      title: title.trim(),
      description: description || '',
      videoUrl,
      r2Key: key,
      fileType: req.file.mimetype || 'video/mp4',
      authorId: authorId || 'anonymous',
      authorName: authorName || 'Beubeuland',
      isAdmin: isAdmin === 'true' || isAdmin === true,
      created_at: new Date().toISOString()
    };

    const { videos, sha } = await getVideosFile();
    videos.unshift(newVideo);
    await saveVideosFile(videos, sha, `Ajout video: ${newVideo.title}`);

    res.json({ success: true, video: newVideo });
  } catch (err) {
    console.error('Erreur upload video:', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ---- Suppression d'une video (admin) ----
app.delete('/api/videos/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { videos, sha } = await getVideosFile();
    const target = videos.find(v => v.id === id);
    if (!target) return res.status(404).json({ error: 'Video introuvable' });

    const updated = videos.filter(v => v.id !== id);
    await saveVideosFile(updated, sha, `Suppression video: ${target.title}`);

    if (target.r2Key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: target.r2Key }));
      } catch (e) {
        console.error('Fichier R2 deja absent ou erreur suppression:', e.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur suppression video:', err);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

app.listen(PORT, () => console.log('✅ Backend beubeuland actif sur le port ' + PORT));
