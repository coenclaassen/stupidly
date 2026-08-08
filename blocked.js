const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "day";
const original = params.get("original") || "";
const navigation = performance.getEntriesByType("navigation")[0];

if (kind === "session" && navigation?.type === "reload" && isSafeOriginal(original)) {
  location.replace(original);
}

function isSafeOriginal(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
