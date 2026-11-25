// Task C: serve the browser UI and proxy read-only RPC calls.
//
//   npm run ui            (then open http://127.0.0.1:8080)
//
// Why a server instead of opening index.html directly:
//   - MetaMask gives file:// pages a hard time, and the page must be able to read
//     BOTH chains at once, while MetaMask is connected to only one.
//   - The RPC endpoints in .env embed API keys. The browser only receives public
//     addresses; JSON-RPC reads are proxied here, so no secret reaches the page.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const {
  allChains,
  amountConfig,
  chainConfig,
  envValue,
  timelockMarginSeconds,
  timelockSeconds,
} = require("./lib/config");
const { loadArtifact } = require("./lib/artifacts");
const { MINIMAL_ERC20_ABI } = require("./lib/chain");

const HOST = "127.0.0.1";
const PORT = Number(process.env.WEB_PORT || 8080);
const ROOT = path.resolve(__dirname, "..");

// Used only if MetaMask has to add the network. Public endpoints, no API keys.
const PUBLIC_RPC = {
  sepolia: "https://rpc.sepolia.org",
  arbitrum: "https://sepolia-rollup.arbitrum.io/rpc",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function publicConfig() {
  const warnings = [];
  const chains = {};

  for (const cfg of allChains()) {
    const htlc = envValue(cfg.htlcEnv) || null;
    if (!htlc) warnings.push(`${cfg.label}: ${cfg.htlcEnv} is empty, so that leg cannot be used. Deploy first (npm run deploy).`);
    if (cfg.asset === "erc20" && !envValue("MST_ADDRESS")) {
      warnings.push(`${cfg.label}: MST_ADDRESS is empty, so the token amount cannot be read.`);
    }
    chains[cfg.name] = {
      name: cfg.name,
      label: cfg.label,
      chainId: cfg.chainId,
      hexChainId: `0x${cfg.chainId.toString(16)}`,
      contract: cfg.contract,
      asset: cfg.asset,
      currency: cfg.currency,
      explorer: cfg.explorer,
      publicRpc: PUBLIC_RPC[cfg.name],
      rpcPath: `/api/rpc/${cfg.name}`,
      htlc,
      mst: cfg.asset === "erc20" ? envValue("MST_ADDRESS") || null : null,
    };
  }

  const roles = {
    alice: envValue("ALICE_ADDRESS") || null,
    bob: envValue("BOB_ADDRESS") || null,
  };
  if (!roles.alice || !roles.bob) warnings.push("ALICE_ADDRESS / BOB_ADDRESS are missing from .env.");

  let defaults;
  try {
    defaults = {
      mstAmount: amountConfig().mst,
      ethAmount: amountConfig().eth,
      timelockSeconds: timelockSeconds(),
      marginSeconds: timelockMarginSeconds(),
    };
  } catch (error) {
    defaults = { mstAmount: "1", ethAmount: "0.001", timelockSeconds: 3600, marginSeconds: 600 };
    warnings.push(error.message);
  }

  const abi = { ERC20: MINIMAL_ERC20_ABI };
  try {
    abi.ERC20HTLC = loadArtifact("ERC20HTLC").abi;
    abi.ETHHTLC = loadArtifact("ETHHTLC").abi;
  } catch {
    warnings.push("Compiled contracts not found. Run \"npx hardhat compile\" before using the UI.");
  }

  return { chains, roles, defaults, abi, warnings, generatedAt: new Date().toISOString() };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function proxyRpc(req, res, chainName) {
  let cfg;
  try {
    cfg = chainConfig(chainName);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const upstreamUrl = envValue(cfg.rpcEnv);
  if (!upstreamUrl) return sendJson(res, 500, { error: `${cfg.rpcEnv} is not set in .env` });

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await upstream.text();

    // Turn provider-level failures (429, 5xx) into a JSON-RPC error with a
    // readable message, so the page can say "rate limited" instead of
    // "missing response for request".
    if (!upstream.ok) {
      let ids = null;
      try {
        const parsed = JSON.parse(body);
        ids = Array.isArray(parsed) ? parsed.map((entry) => entry.id ?? null) : parsed.id ?? null;
      } catch {
        // Body was not JSON; fall back to a null id.
      }
      const message = `upstream RPC HTTP ${upstream.status}${upstream.status === 429 ? " (rate limited by the provider)" : ""}`;
      const payload = Array.isArray(ids)
        ? ids.map((id) => ({ jsonrpc: "2.0", id, error: { code: -32000, message } }))
        : { jsonrpc: "2.0", id: ids, error: { code: -32000, message } };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(payload));
    }

    res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(text);
  } catch (error) {
    sendJson(res, 502, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: `upstream RPC unreachable: ${error.message}` },
    });
  }
}

function resolveStatic(pathname) {
  if (pathname === "/" || pathname === "") return path.join(ROOT, "web", "index.html");
  if (pathname === "/vendor/ethers.umd.min.js") {
    return path.join(ROOT, "node_modules", "ethers", "dist", "ethers.umd.min.js");
  }
  if (pathname.startsWith("/shared/")) return path.join(ROOT, pathname.slice(1));
  return path.join(ROOT, "web", pathname.slice(1));
}

function serveStatic(req, res, pathname) {
  const file = path.resolve(resolveStatic(pathname));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/config") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
    return sendJson(res, 200, publicConfig());
  }

  if (pathname.startsWith("/api/rpc/")) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    return proxyRpc(req, res, pathname.slice("/api/rpc/".length));
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  serveStatic(req, res, pathname);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Stop the other process or run with WEB_PORT=8081.`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  const config = publicConfig();
  console.log("");
  console.log("COMP5521 HTLC swap UI (Task C)");
  console.log("-".repeat(46));
  console.log(`  open        http://${HOST}:${PORT}`);
  console.log(`  sepolia     ${config.chains.sepolia.htlc || "(not deployed)"}  ERC20HTLC`);
  console.log(`  arbitrum    ${config.chains.arbitrum.htlc || "(not deployed)"}  ETHHTLC`);
  console.log("  rpc         proxied from .env; the browser only sees this server");
  console.log("  signer      MetaMask (the connected account is the acting role)");
  if (config.warnings.length > 0) {
    console.log("");
    for (const warning of config.warnings) console.log(`  [!!] ${warning}`);
  }
  console.log("");
  console.log("  press Ctrl+C to stop");
});

