// Direct Bot API room policy. Keep it separate from private-route and XMPP schemas.
export const ROOM_BACKLOG_LIMIT = 4;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const canonicalId = id => typeof id === 'string' && Number.isSafeInteger(Number(id)) && String(Number(id)) === id;
export const isRoomChatId = id => canonicalId(id) && Number(id) < 0;
export const isRoomMemberId = id => canonicalId(id) && Number(id) > 0;

export function normalizeRoomInstructions(value) {
  if (typeof value !== 'string' || value.length > 2000) {
    throw new TypeError('Room instructions must be text of at most 2000 UTF-16 code units');
  }
  const text = value.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(text)) {
    throw new TypeError('Room instructions must not contain control characters');
  }
  return text.trim();
}

export function roomBotUsername(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !BOT_USERNAME.test(value)) {
    throw new TypeError('Set MANOLO_TELEGRAM_BOT_USERNAME to the bot username without @');
  }
  return value.toLowerCase();
}

export function admittedRoom(room, userId, mentioned) {
  return room?.members.has(userId) && (room.wake === 'all' || mentioned === true);
}
