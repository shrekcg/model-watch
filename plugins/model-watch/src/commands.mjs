const COMMAND_PATTERN = /^\s*\$model-watch(?:\s+([^\s,，(（]+))?\s*(?:（[^）]*）)?\s*(?:[,，]\s*)?/u;

export function parseModelWatchCommand(prompt) {
  const text = String(prompt || "");
  const match = text.match(COMMAND_PATTERN);
  if (!match) return null;

  const rawAction = (match[1] || "on").toLowerCase();
  const action = rawAction === "enable" ? "on" : rawAction;
  const validActions = new Set([
    "on",
    "off",
    "status",
    "settings",
    "check",
    "check-inline",
    "gate-next",
    "sync"
  ]);
  if (!validActions.has(action)) return { action: "unknown", argument: rawAction, remainder: "" };

  let remainder = text.slice(match[0].length).trim();
  let argument = null;
  if (action === "sync") {
    argument = remainder.split(/\s+/u)[0] || null;
    remainder = remainder.slice(argument?.length || 0).replace(/^\s*[,，]\s*/u, "").trim();
  }

  return { action, argument, remainder };
}
