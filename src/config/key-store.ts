import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './env.js';

// Keys live in config.server.apiKeys (read live by auth on every request), so
// mutating the object takes effect immediately without a restart. Changes are
// also written back to .env so they survive a reboot.
const ENV_FILE = path.join(config.projectRoot, '.env');

function persist(): void {
  const line = `BRIDGE_API_KEYS=${JSON.stringify(config.server.apiKeys)}`;
  let text = '';
  if (fs.existsSync(ENV_FILE)) {
    text = fs.readFileSync(ENV_FILE, 'utf8');
    if (/^BRIDGE_API_KEYS=.*$/m.test(text)) {
      text = text.replace(/^BRIDGE_API_KEYS=.*$/m, line);
    } else {
      text = text.replace(/\n?$/, '\n') + line + '\n';
    }
  } else {
    text = line + '\n';
  }
  fs.writeFileSync(ENV_FILE, text, 'utf8');
}

export function listKeys(): Array<{ user: string; key: string }> {
  return Object.entries(config.server.apiKeys).map(([user, key]) => ({ user, key }));
}

export function addKey(rawUser: string): { user: string; key: string } {
  const user = rawUser.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!user) throw new Error('Tên user không hợp lệ (chỉ a-z, 0-9, _ -).');
  if (config.server.apiKeys[user]) throw new Error(`User "${user}" đã có key rồi.`);
  const key = `sk-${crypto.randomBytes(16).toString('hex')}`;
  config.server.apiKeys[user] = key;
  persist();
  return { user, key };
}

export function removeKey(user: string): void {
  if (user === config.server.defaultUserId) {
    throw new Error('Không được xóa key của user mặc định.');
  }
  if (!config.server.apiKeys[user]) throw new Error(`Không tìm thấy user "${user}".`);
  delete config.server.apiKeys[user];
  persist();
}
