import { EventEmitter } from 'node:events';

/**
 * Шина доменных событий. REST-слой публикует, realtime-слой рассылает
 * заинтересованным WS-соединениям. Так HTTP и WebSocket не знают друг о друге.
 *
 * События:
 *   message:new        { conversationId, message, memberIds }
 *   message:updated    { conversationId, message, memberIds }
 *   message:deleted    { conversationId, messageId, memberIds }
 *   conversation:new   { conversation, memberIds }
 *   conversation:updated { conversation, memberIds }
 *   member:added       { conversationId, memberIds, addedIds }
 *   member:removed     { conversationId, memberIds, removedId }
 *   presence           { userId, online, lastSeenAt }
 *   typing             { conversationId, userId, memberIds }
 *   read               { conversationId, userId, messageId, memberIds }
 *   friend:request     { toUserId, request }
 *   friend:accepted    { userId, request }
 *   friend:removed     { userId, friendId }
 *   user:updated       { userId, user }
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emit(event, payload) {
  bus.emit(event, payload);
}
