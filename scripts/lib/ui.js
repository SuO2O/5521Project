// Plain-ASCII console helpers shared by the Part B scripts.
// ASCII only, so output renders in any Windows terminal.

function heading(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(Math.max(24, Math.min(78, title.length))));
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(11)} ${value}`);
}

function ok(message) {
  console.log(`  [ok] ${message}`);
}

function warn(message) {
  console.log(`  [!!] ${message}`);
}

function info(message) {
  console.log(`  [..] ${message}`);
}

function table(headers, rows, indent = "  ") {
  const widths = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[index] ?? "").length))
  );
  const render = (cells) =>
    indent + cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
  console.log(render(headers));
  console.log(indent + widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(render(row));
}

function formatDuration(seconds) {
  const abs = Math.abs(Math.round(seconds));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (hours === 0 && (minutes === 0 || secs > 0)) parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatTimestamp(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

function formatWindow(labels) {
  if (labels.claimable) return `claimable, expires in ${formatDuration(labels.secondsToExpiry)}`;
  if (labels.refundable) return `expired ${formatDuration(-labels.secondsToExpiry)} ago, refundable`;
  if (labels.claimed) return "claimed (completed)";
  if (labels.refunded) return "refunded (completed)";
  if (!labels.exists) return "no such swap";
  return "not claimable or refundable";
}

module.exports = {
  formatDuration,
  formatTimestamp,
  formatWindow,
  heading,
  info,
  line,
  ok,
  table,
  warn,
};
