const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const CHAT_ADJ_ROOT = path.join(__dirname, '..', '..', 'data', 'chat-adjuntos');

const MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.txt',
  '.csv',
  '.md',
  '.rtf',
  '.zip',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.opus',
  '.webm',
]);

function ensureChatAdjRoot() {
  if (!fs.existsSync(CHAT_ADJ_ROOT)) {
    fs.mkdirSync(CHAT_ADJ_ROOT, { recursive: true });
  }
}

function sameUuid(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function safeBaseName(original) {
  let base = path.basename(original || 'archivo').replace(/[/\\]/g, '');
  base = base.replace(/[^\w.\- ()\[\]+áéíóúÁÉÍÓÚñÑüÜ]/g, '_');
  if (base.length > 180) base = base.slice(-180);
  return base || 'archivo';
}

function isAllowedExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ALLOWED_EXT.has(ext);
}

function adjuntoAbsoluteOrNull(reunionId, relPath) {
  const norm = String(relPath || '')
    .replace(/\\/g, '/')
    .trim();
  if (!norm || norm.includes('..')) return null;
  const seg = norm.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  if (!sameUuid(seg[0], reunionId)) return null;
  const absRoot = path.resolve(CHAT_ADJ_ROOT);
  const absFile = path.resolve(path.join(CHAT_ADJ_ROOT, ...seg));
  if (!absFile.startsWith(absRoot + path.sep)) return null;
  return absFile;
}

function reunionUploadDir(reunionId) {
  const dir = path.join(CHAT_ADJ_ROOT, String(reunionId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function multerFilename(originalname) {
  const id = randomUUID();
  const base = safeBaseName(originalname);
  return `${id}_${base}`;
}

function posixRelPath(reunionId, filename) {
  return path.posix.join(String(reunionId), filename);
}

module.exports = {
  CHAT_ADJ_ROOT,
  MAX_BYTES,
  ALLOWED_EXT,
  ensureChatAdjRoot,
  safeBaseName,
  isAllowedExtension,
  adjuntoAbsoluteOrNull,
  reunionUploadDir,
  multerFilename,
  posixRelPath,
};
