const COMMAND_PATTERN = /^\s*[!$]model-watch(?:\s+([^\s,，(（]+))?\s*(?:（[^）]*）)?\s*(?:[,，]\s*)?/u;

export function parseModelWatchCommand(prompt) {
  const text = String(prompt || "");
  const match = text.match(COMMAND_PATTERN);
  if (!match) return null;
  const aliases = { enable: "on", stop: "pause", start: "resume" };
  const rawAction = (match[1] || "on").toLowerCase();
  const action = aliases[rawAction] || rawAction;
  const validActions = new Set([
    "on",
    "off",
    "pause",
    "resume",
    "status",
    "settings",
    "check",
    "check-inline",
    "test-card",
    "test"
  ]);
  if (!validActions.has(action)) return { action: "unknown", argument: rawAction, remainder: "" };
  return { action, argument: null, remainder: text.slice(match[0].length).trim() };
}
