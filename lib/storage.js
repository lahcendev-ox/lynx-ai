// تخزين المحادثات في ملفات JSON.
// البنية:  <DATA_DIR>/users/<deviceId>/<chatId>.json
// كل جهاز له مجلده الخاص، فلا يمكن أن تختلط محادثات مستخدمين مختلفين.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_RE = /^[0-9a-f]{16}$/;

export function createStorage(rootDir) {
  const usersDir = path.join(rootDir, 'users');

  const isValidDevice = (id) => typeof id === 'string' && DEVICE_RE.test(id);
  const isValidChat = (id) => typeof id === 'string' && CHAT_RE.test(id);

  // نتحقق من المعرّفات بالتعبيرات النمطية قبل استعمالها في المسارات،
  // وهذا يمنع أي محاولة للخروج من المجلد (../).
  const deviceDir = (deviceId) => path.join(usersDir, deviceId.toLowerCase());
  const chatFile = (deviceId, chatId) => path.join(deviceDir(deviceId), `${chatId}.json`);

  // نكتب في ملف مؤقت ثم نعيد تسميته، حتى لا يبقى ملف نصف مكتوب لو توقف السيرفر فجأة.
  async function writeAtomic(file, data) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function createChat(deviceId) {
    await fs.mkdir(deviceDir(deviceId), { recursive: true });
    const now = Date.now();
    const chat = {
      id: crypto.randomBytes(8).toString('hex'),
      title: 'محادثة جديدة',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await writeAtomic(chatFile(deviceId, chat.id), chat);
    return chat;
  }

  async function getChat(deviceId, chatId) {
    if (!isValidChat(chatId)) return null;
    return readJson(chatFile(deviceId, chatId));
  }

  async function saveChat(deviceId, chat) {
    chat.updatedAt = Date.now();
    await writeAtomic(chatFile(deviceId, chat.id), chat);
  }

  async function deleteChat(deviceId, chatId) {
    if (!isValidChat(chatId)) return;
    await fs.rm(chatFile(deviceId, chatId), { force: true });
  }

  async function listChats(deviceId) {
    let names;
    try {
      names = await fs.readdir(deviceDir(deviceId));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const chats = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const chat = await readJson(path.join(deviceDir(deviceId), name));
            if (!chat) return null;
            return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt };
          } catch {
            return null; // ملف تالف: نتجاهله ولا نُسقط القائمة كلها
          }
        })
    );

    return chats.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return { isValidDevice, isValidChat, createChat, getChat, saveChat, deleteChat, listChats };
}
