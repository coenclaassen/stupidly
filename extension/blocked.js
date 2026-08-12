const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "day";
const original = params.get("original") || "";
const navigation = performance.getEntriesByType("navigation")[0];
const messages = [
  "This isn't getting you anywhere.",
  "That's enough for now.",
  "Your time is worth more than this.",
  "You set the limit. Stick to it.",
  "Time's up. Keep moving.",
  "You can come back later.",
  "Congratulations. You reached the end.",
  "Go do what you were avoiding.",
  "The internet won. Until now."
];

if (kind === "session" && navigation?.type === "reload" && isSafeOriginal(original)) {
  location.replace(original);
}

const previousMessage = localStorage.getItem("lastBlockedMessage");
const availableMessages = messages.filter((candidate) => candidate !== previousMessage);
const message = availableMessages[Math.floor(Math.random() * availableMessages.length)];
localStorage.setItem("lastBlockedMessage", message);
const messageElement = document.getElementById("blocked-message");
if (messageElement) {
  messageElement.textContent = message;
  document.title = message;
}

function isSafeOriginal(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
