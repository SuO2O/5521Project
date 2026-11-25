// Small, dependency-free .env writer used after deployments and after a swap.
//
// It only rewrites the keys it is given and leaves every other line (including
// comments and the trailing newline) untouched, so .env stays the user's file.
const fs = require("node:fs");
const path = require("node:path");

const ENV_PATH = path.resolve(__dirname, "..", "..", ".env");

function updateEnvFile(updates, filePath = ENV_PATH) {
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const pending = new Map(Object.entries(updates).map(([key, value]) => [key, String(value)]));
  const applied = [];

  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match && pending.has(match[1])) {
      const key = match[1];
      const value = pending.get(key);
      pending.delete(key);
      applied.push(key);
      return `${key}=${value}`;
    }
    return line;
  });

  for (const [key, value] of pending) {
    lines.push(`${key}=${value}`);
    applied.push(key);
  }

  const text = lines.join("\n");
  fs.writeFileSync(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return applied;
}

module.exports = { ENV_PATH, updateEnvFile };
