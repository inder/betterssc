// Notification trigger logic. Tests each incoming chat event against the
// user's identity; if it's an @mention, forwards a message to the background
// service worker which fires chrome.notifications.

import { segmentBody, mentionsUser } from "./util.js";

let unreadMentions = 0;

export const resetUnreadMentions = () => {
  unreadMentions = 0;
  chrome.runtime.sendMessage({ type: "setBadge", count: 0 });
};

export const incrementUnreadMentions = () => {
  unreadMentions += 1;
  chrome.runtime.sendMessage({ type: "setBadge", count: unreadMentions });
};

export const getUnreadMentions = () => unreadMentions;

// Inspect a new comment. If it's a mention of the user, fire a notification.
// Returns true if a notification was fired.
export const maybeNotifyMention = ({ comment, user, settings }) => {
  if (!comment || !user) return false;
  if (settings && settings.notificationsEnabled === false) return false;
  // Don't notify on user's own messages.
  if (comment.author && comment.author.id === user.id) return false;

  // Expand body with mentions and check.
  const segments = segmentBody(comment.body, comment.mentions);
  const expanded = segments.map((s) => s.value).join("");
  const isMention = mentionsUser(expanded, user.name, user.handle);

  if (!isMention) {
    // Also check mention map directly for user_id match.
    if (comment.mentions) {
      for (const m of Object.values(comment.mentions)) {
        if (m && m.user_id === user.id) {
          fireNotification(comment, expanded);
          incrementUnreadMentions();
          return true;
        }
      }
    }
    return false;
  }

  fireNotification(comment, expanded);
  incrementUnreadMentions();
  return true;
};

const fireNotification = (comment, expandedBody) => {
  const title = `@mention from ${comment.author && comment.author.name}`;
  const message = expandedBody.slice(0, 200);
  chrome.runtime.sendMessage({
    type: "notify",
    title,
    message,
    mentionRef: comment.id,
  });
};
