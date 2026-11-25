// Task C: single-page browser UI for the cross-chain HTLC swap.
//
// Reads go through the local server's read-only RPC proxy, so both chains can be
// observed at the same time. Writes are signed by MetaMask with an explicit
// account: the page picks the signer address from the selected actor, so it can
// sign as Bob even while MetaMask's own account menu shows Alice. Network changes
// are explicit (header buttons). The protocol rules are shared with the CLI
// through /shared/htlc-core.js.
(function () {
  const { ethers } = window;
  const core = window.HtlcCore.create(ethers);
  const LEGS = { mst: "sepolia", eth: "arbitrum" };
  const LOCKED_TOPIC = ethers.id("Locked(bytes32,address,address,address,uint256,bytes32,uint256)");
  const STORAGE_KEY = "comp5521-htlc-swap-v1";
  const PREFS_KEY = "comp5521-htlc-actor-v1";

  const state = {
    config: null,
    accounts: [], // accounts MetaMask has authorised
    activeRole: "alice", // who the page signs as
    hasStoredRole: false,
    account: null, // active role's address
    chainId: null,
    walletProvider: null,
    read: {},
    swap: null,
    chains: {},
    observed: {},
    lastTx: {},
    decimals: 18,
    busy: false,
    revealPreimage: false,
    demoAll: false, // demo mode: show every action and let the contract reject the invalid ones
    refreshing: false,
    retryTimer: null,
    failStreak: 0,
    nextRetryAt: null,
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- boot

  async function boot() {
    try {
      const response = await fetch("/api/config");
      if (!response.ok) throw new Error(`config request failed (${response.status})`);
      state.config = await response.json();
    } catch (error) {
      showWarning(`Cannot load the server configuration (${error.message}). Start the page with "npm run ui".`);
      return;
    }

    if (state.config.warnings && state.config.warnings.length > 0) {
      showWarning(state.config.warnings.join(" "));
    }

    for (const [name, cfg] of Object.entries(state.config.chains)) {
      if (cfg.rpcPath) state.read[name] = new ethers.JsonRpcProvider(location.origin + cfg.rpcPath);
    }

    restoreSwap();
    loadPrefs();
    $("show-all-actions").checked = state.demoAll;
    if (!state.hasStoredRole) {
      if (isAuthorised("alice")) state.activeRole = "alice";
      else if (isAuthorised("bob")) state.activeRole = "bob";
    }
    state.account = state.config.roles[state.activeRole] || null;
    applySwapToInputs();
    wireEvents();
    render();
    refresh();
    loadDecimals();
    setInterval(() => refresh(), 20000);
    setInterval(renderCountdowns, 1000);

    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts && accounts.length > 0) await refreshWallet();
      } catch {
        // Not authorised yet; the Connect button handles it.
      }
    } else {
      log("err", "MetaMask was not found in this browser.");
    }
  }

  function showWarning(text) {
    const banner = $("config-warning");
    banner.textContent = text;
    banner.classList.remove("hidden");
  }

  // -------------------------------------------------------------- wallet

  async function refreshWallet() {
    state.walletProvider = new ethers.BrowserProvider(window.ethereum);
    state.accounts = (await window.ethereum.request({ method: "eth_accounts" })) || [];
    state.chainId = Number((await state.walletProvider.getNetwork()).chainId);
    if (!state.hasStoredRole) {
      if (isAuthorised("alice")) state.activeRole = "alice";
      else if (isAuthorised("bob")) state.activeRole = "bob";
    }
    state.account = state.config.roles[state.activeRole] || null;
    render();
  }

  async function connect() {
    if (!window.ethereum) {
      log("err", "MetaMask was not found in this browser.");
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await refreshWallet();
      if (isAuthorised(state.activeRole)) {
        log("ok", `Connected ${capitalise(state.activeRole)} (${short(state.account)}) on ${networkLabel(state.chainId)}`);
        setFeedback("global-feedback", "ok", `Connected — acting as ${capitalise(state.activeRole)}`, [
          `Address ${state.account}`,
          `Network ${networkLabel(state.chainId)}.`,
          "Choose Alice or Bob in section 3, then use the action buttons in that account's card.",
        ]);
      } else {
        log("info", `Connected, but ${capitalise(state.activeRole)} (${short(state.account)}) is not authorised yet. Press “Act as ${capitalise(state.activeRole)}” and tick that account in MetaMask.`);
        setFeedback("global-feedback", "warn", "Connected — but the acting account is not authorised", [
          `MetaMask has not shared ${capitalise(state.activeRole)} (${short(state.account)}) with this page.`,
          `Press “Act as ${capitalise(state.activeRole)}” and tick that account in the popup.`,
        ]);
      }
    } catch (error) {
      const message = describeError(error);
      log("err", `Connection failed: ${message}`);
      setFeedback("global-feedback", "err", "Connection failed", [message]);
    }
  }

  async function disconnect() {
    try {
      await window.ethereum.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      log("info", "Disconnected. MetaMask no longer authorises this page.");
    } catch {
      log("info", "Disconnected here. To revoke fully, use MetaMask → Connected sites → remove this page.");
    }
    state.accounts = [];
    state.walletProvider = null;
    state.chainId = null;
    state.account = state.config.roles[state.activeRole] || null;
    render();
    setFeedback("global-feedback", "info", "Disconnected", [
      "This page no longer has MetaMask's accounts. Reconnect to sign another transaction.",
    ]);
  }

  async function switchNetwork(name) {
    const cfg = state.config.chains[name];
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: cfg.hexChainId }],
      });
    } catch (error) {
      if (error.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: cfg.hexChainId,
            chainName: cfg.label,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [cfg.publicRpc],
            blockExplorerUrls: [cfg.explorer],
          }],
        });
      } else {
        throw error;
      }
    }
    await refreshWallet();
    log("ok", `MetaMask is now on ${cfg.label}`);
    setFeedback("global-feedback", "ok", `Network switched — ${cfg.label}`, [
      `Chain id ${cfg.chainId} (0x${cfg.chainId.toString(16)}).`,
      "Actions that need this chain are now available.",
    ]);
  }

  function isAuthorised(role) {
    const address = state.config && state.config.roles[role];
    if (!address) return false;
    return state.accounts.some((account) => core.isSameAddress(account, address));
  }

  async function actAs(role) {
    if (state.activeRole === role) return;
    state.activeRole = role;
    state.hasStoredRole = true;
    state.account = state.config.roles[role] || null;
    savePrefs();
    render();
    log("info", `Acting as ${capitalise(role)} (${short(state.account)}).`);
    setFeedback(`actor-${role}-feedback`, "info", `Acting as ${capitalise(role)}`, [
      `Transactions will be signed by ${state.config.roles[role]}.`,
      state.accounts.length === 0
        ? "Connect MetaMask to sign."
        : isAuthorised(role)
          ? "This account is authorised in MetaMask."
          : "Press the account in the MetaMask popup to authorise it.",
    ]);
    if (state.accounts.length > 0 && !isAuthorised(role)) await requestAccounts();
  }

  async function requestAccounts() {
    try {
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      await refreshWallet();
      if (isAuthorised(state.activeRole)) {
        log("ok", `MetaMask authorised ${capitalise(state.activeRole)}.`);
      } else {
        log("info", `MetaMask did not include ${capitalise(state.activeRole)}. Tick that account in the MetaMask popup, then try again.`);
      }
    } catch (error) {
      log("info", `MetaMask kept its authorisation: ${describeError(error)}`);
    }
  }

  function ensureActor(role) {
    if (state.activeRole === role) return;
    state.activeRole = role;
    state.hasStoredRole = true;
    state.account = state.config.roles[role] || null;
    savePrefs();
    render();
    log("info", `Acting as ${capitalise(role)}.`);
  }

  async function ensureSigner(chainName) {
    if (!state.walletProvider) throw new Error("Connect MetaMask first.");
    const role = state.activeRole;
    const address = state.config.roles[role];
    if (!address) throw new Error(`${capitalise(role)}'s address is not configured in .env.`);

    if (!isAuthorised(role)) {
      await requestAccounts();
      if (!isAuthorised(role)) {
        throw new Error(`MetaMask has not authorised ${capitalise(role)} (${short(address)}). Press “Act as ${capitalise(role)}” and tick that account in the popup.`);
      }
    }

    const cfg = state.config.chains[chainName];
    if (state.chainId !== cfg.chainId) {
      if (state.demoAll) {
        // In the demo, switching networks is part of the flow, so do it on demand.
        log("info", `Demo mode: asking MetaMask to switch to ${cfg.label}...`);
        await switchNetwork(chainName);
      }
      if (state.chainId !== cfg.chainId) {
        throw new Error(`Wrong network: MetaMask is on ${networkLabel(state.chainId)}. Use “Switch to ${cfg.label}”, then retry.`);
      }
    }
    return state.walletProvider.getSigner(address);
  }

  // ----------------------------------------------------------- read side

  async function loadDecimals() {
    const cfg = state.config.chains.sepolia;
    if (!cfg || !cfg.mst || !state.read.sepolia) return;
    try {
      const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, state.read.sepolia);
      state.decimals = Number(await token.decimals());
    } catch {
      state.decimals = 18;
    }
    render();
  }

  function legChain(leg) {
    return state.config.chains[LEGS[leg]];
  }

  function legSwapId(leg) {
    if (!state.swap) return null;
    return leg === "mst" ? state.swap.mstSwapId : state.swap.ethSwapId;
  }

  async function readBalances(chainName) {
    const provider = state.read[chainName];
    const roles = state.config.roles;
    const result = { alice: { eth: 0n, mst: null }, bob: { eth: 0n, mst: null } };
    for (const role of ["alice", "bob"]) {
      if (roles[role]) result[role].eth = await provider.getBalance(roles[role]);
    }
    if (chainName === "sepolia" && state.config.chains.sepolia.mst) {
      const token = new ethers.Contract(state.config.chains.sepolia.mst, state.config.abi.ERC20, provider);
      for (const role of ["alice", "bob"]) {
        if (roles[role]) result[role].mst = await token.balanceOf(roles[role]);
      }
    }
    return result;
  }

  async function readChain(chainName) {
    const cfg = state.config.chains[chainName];
    const previous = state.chains[chainName];
    try {
      const provider = state.read[chainName];
      const block = await provider.getBlock("latest");
      const balances = await readBalances(chainName);
      let escrowEth = previous && !previous.error ? previous.escrowEth : null;
      let mstEscrow = previous && !previous.error ? previous.mstEscrow : null;
      if (cfg.htlc) {
        escrowEth = await provider.getBalance(cfg.htlc);
        if (chainName === "sepolia" && cfg.mst) {
          const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, provider);
          mstEscrow = await token.balanceOf(cfg.htlc);
        }
      }
      state.chains[chainName] = {
        chainName,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        observedAt: Date.now(),
        baseFee: block.baseFeePerGas || null,
        balances,
        escrowEth,
        mstEscrow,
        lastError: null,
      };
    } catch (error) {
      const message = describeError(error);
      state.chains[chainName] = previous && !previous.error
        ? { ...previous, lastError: message }
        : { chainName, error: message };
    }
  }

  async function readAllowance() {
    const cfg = state.config.chains.sepolia;
    const roles = state.config.roles;
    if (!cfg.mst || !roles.alice || !cfg.htlc) return null;
    const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, state.read.sepolia);
    return token.allowance(roles.alice, cfg.htlc);
  }

  async function readLeg(leg) {
    const chainName = LEGS[leg];
    const cfg = legChain(leg);
    const swapId = legSwapId(leg);
    const chain = state.chains[chainName];
    const previous = state.observed[leg];

    if (!cfg || !cfg.htlc || !swapId || !chain || chain.error) {
      state.observed[leg] = null;
      return;
    }
    try {
      const contract = new ethers.Contract(cfg.htlc, state.config.abi[cfg.contract], state.read[chainName]);
      const swap = core.decodeSwap(await contract.getSwap(swapId));
      state.observed[leg] = {
        chainName,
        swap,
        labels: core.classify(swap, chain.blockTimestamp),
        allowance: leg === "mst" ? await readAllowance() : null,
        lastError: null,
      };
    } catch (error) {
      const message = describeError(error);
      state.observed[leg] = previous && previous.swap
        ? { ...previous, lastError: message }
        : { chainName, error: message };
    }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      await readChain("sepolia");
      await readChain("arbitrum");
      await readLeg("mst");
      await readLeg("eth");
    } finally {
      state.refreshing = false;
    }
    render();

    const missing = (name) => !state.chains[name] || state.chains[name].error;
    if (missing("sepolia") || missing("arbitrum")) {
      state.failStreak = Math.min((state.failStreak || 0) + 1, 4);
      const delay = Math.min(30000, 4000 * 2 ** (state.failStreak - 1));
      state.nextRetryAt = Date.now() + delay;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(() => refresh(), delay);
    } else {
      state.failStreak = 0;
      state.nextRetryAt = null;
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
    }
  }

  async function refreshWithFeedback() {
    await refresh();
    const sepolia = state.chains.sepolia;
    const arbitrum = state.chains.arbitrum;
    setFeedback("global-feedback", "info", "State refreshed", [
      sepolia && !sepolia.error ? `Ethereum Sepolia: block #${sepolia.blockNumber}.` : "Ethereum Sepolia: read failed, retrying.",
      arbitrum && !arbitrum.error ? `Arbitrum Sepolia: block #${arbitrum.blockNumber}.` : "Arbitrum Sepolia: read failed, retrying.",
      "Balances and lock states were re-read from both chains.",
    ]);
  }

  // --------------------------------------------------------------- fees

  async function gasOverrides(chainName) {
    const provider = state.read[chainName];
    const [block, fee] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
    const baseFee = block && block.baseFeePerGas ? block.baseFeePerGas : 0n;
    const priority = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas > 0n
      ? fee.maxPriorityFeePerGas
      : 1_000_000n;
    const suggested = fee.maxFeePerGas && fee.maxFeePerGas > 0n ? fee.maxFeePerGas : 0n;
    const buffered = (suggested * 150n) / 100n;
    const floor = baseFee * 2n + priority;
    return {
      maxFeePerGas: buffered > floor ? buffered : floor,
      maxPriorityFeePerGas: priority,
    };
  }

  function doubleFees(overrides) {
    return {
      maxFeePerGas: overrides.maxFeePerGas * 2n,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas * 2n,
    };
  }

  async function sendTx(chainName, build) {
    const overrides = await gasOverrides(chainName);
    try {
      return await build(overrides);
    } catch (error) {
      const message = `${describeError(error)} ${(error && error.message) || ""}`;
      if (!/max fee per gas less than block base fee|transaction underpriced/i.test(message)) throw error;
      log("info", "The chain's base fee rose before signing; retrying with a higher gas price...");
      return build(doubleFees(overrides));
    }
  }

  // ---------------------------------------------------------- write side

  async function run(label, action, role) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      const message = describeError(error);
      const hint = /max fee per gas less than block base fee/i.test(message)
        ? "MetaMask may be using a manual gas setting; set it to Market/site suggested and retry."
        : "";
      setFeedback(role ? `actor-${role}-feedback` : "global-feedback", "err", `${label} failed`, [message, hint].filter(Boolean));
      log("err", `${label}: ${message}${hint ? ` — ${hint}` : ""}`);
    } finally {
      state.busy = false;
      render();
      await refresh();
    }
  }

  function assertClaimable(leg) {
    const observation = state.observed[leg];
    if (!observation || !observation.swap || observation.swap.state === "None") {
      throw new Error(`No ${leg.toUpperCase()} swap found on chain.`);
    }
    if (!observation.labels.claimable) {
      const why = observation.labels.expired ? "its timelock has expired" : `its state is ${observation.swap.state}`;
      throw new Error(`The ${leg.toUpperCase()} leg cannot be claimed: ${why}.`);
    }
  }

  function assertRefundable(leg) {
    const observation = state.observed[leg];
    if (!observation || !observation.swap || observation.swap.state === "None") {
      throw new Error(`No ${leg.toUpperCase()} swap found on chain.`);
    }
    if (!observation.labels.refundable) {
      const why = observation.swap.state !== "Active"
        ? `its state is ${observation.swap.state}`
        : "the timelock has not expired yet";
      throw new Error(`The ${leg.toUpperCase()} leg cannot be refunded: ${why}.`);
    }
  }

  async function approveMst() {
    return run("Approve MST", async () => {
      ensureActor("alice");
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const amount = parseMst(state.swap.mstAmount);
      const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, signer);
      log("info", `Approving ${state.swap.mstAmount} MST for the escrow...`);
      const tx = await sendTx("sepolia", (overrides) => token.approve(cfg.htlc, amount, overrides));
      await tx.wait(1);
      log("ok", `Approved ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
      setFeedback("actor-alice-feedback", "ok", `Approval confirmed — ${state.swap.mstAmount} MST`, [
        `The escrow (${short(cfg.htlc)}) may now pull ${state.swap.mstAmount} MST from Alice.`,
        `Transaction ${tx.hash}.`,
        "Next: Lock MST.",
      ]);
    }, "alice");
  }

  async function lockMst() {
    return run("Lock MST", async () => {
      ensureActor("alice");
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const block = await state.read.sepolia.getBlock("latest");
      const deadline = block.timestamp + Number(state.swap.timelockSeconds) + Number(state.swap.marginSeconds);
      const amount = parseMst(state.swap.mstAmount);
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);

      log("info", `Locking ${state.swap.mstAmount} MST for Bob until ${core.formatTimestamp(deadline)}...`);
      const tx = await sendTx("sepolia", (overrides) =>
        htlc.lock(state.swap.mstSwapId, cfg.mst, state.config.roles.bob, amount, state.swap.hashlock, deadline, overrides)
      );
      await tx.wait(1);
      state.swap.mstDeadline = deadline;
      state.swap.mstVerified = null;
      saveSwap();
      log("ok", `Locked ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
      await verifyLock("mst", {
        sender: state.config.roles.alice,
        recipient: state.config.roles.bob,
        token: cfg.mst,
        amount,
        hashlock: state.swap.hashlock,
        timelock: deadline,
      });
      setFeedback("actor-alice-feedback", "ok", `MST locked — ${state.swap.mstAmount} MST held for Bob`, [
        `Transaction ${tx.hash} confirmed on Ethereum Sepolia.`,
        `Deadline ${core.formatTimestamp(deadline)} (in ${core.formatDuration(deadline - block.timestamp)}), i.e. the ${state.swap.timelockSeconds}s timelock plus the ${state.swap.marginSeconds}s margin.`,
        `The ETH deadline will be this MST deadline minus the ${state.swap.marginSeconds}s margin, so the MST always outlives the ETH by the margin.`,
        `Hashlock ${short(state.swap.hashlock)} — the stored lock matched all 7 fields (state, sender, recipient, token, amount, hashlock, timelock).`,
        "Next: Bob verifies the lock and locks the ETH on Arbitrum.",
      ]);
    }, "alice");
  }

  async function readMstLock() {
    const cfg = state.config.chains.sepolia;
    const observed = state.observed.mst;
    if (observed && observed.swap && observed.swap.state !== "None") return observed.swap;
    const contract = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, state.read.sepolia);
    const record = core.decodeSwap(await contract.getSwap(state.swap.mstSwapId));
    if (record.state === "None") throw new Error("Alice has not locked the MST yet.");
    if (record.state !== "Active") throw new Error(`The MST leg is ${record.state}, not Active; there is nothing to lock ETH against.`);
    return record;
  }

  async function lockEth() {
    return run("Lock ETH", async () => {
      ensureActor("bob");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const mstLock = await readMstLock();
      const block = await state.read.arbitrum.getBlock("latest");
      const margin = Number(state.swap.marginSeconds);
      // The margin comes off the MST deadline, so the MST always expires exactly
      // `margin` after the ETH no matter how long Bob waited to lock it.
      const deadline = Number(mstLock.timelock) - margin;
      if (deadline <= block.timestamp + 60) {
        throw new Error(
          `Too late to lock the ETH safely: the MST expires at ${core.formatTimestamp(Number(mstLock.timelock))} ` +
            `and the ${margin}s margin would leave only ${deadline - block.timestamp}s. Start a new swap with a larger timelock.`
        );
      }
      const value = parseEth(state.swap.ethAmount);
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);

      log("info", `Locking ${state.swap.ethAmount} ETH for Alice until ${core.formatTimestamp(deadline)}...`);
      const tx = await sendTx("arbitrum", (overrides) =>
        htlc.lock(state.swap.ethSwapId, state.config.roles.alice, state.swap.hashlock, deadline, { value, ...overrides })
      );
      await tx.wait(1);
      state.swap.ethDeadline = deadline;
      saveSwap();
      log("ok", `Locked ${state.swap.ethAmount} ETH`, { chain: "arbitrum", hash: tx.hash, leg: "eth" });
      await verifyLock("eth", {
        sender: state.config.roles.bob,
        recipient: state.config.roles.alice,
        token: ethers.ZeroAddress,
        amount: value,
        hashlock: state.swap.hashlock,
        timelock: deadline,
      });
      setFeedback("actor-bob-feedback", "ok", `ETH locked — ${state.swap.ethAmount} ETH held for Alice`, [
        `Transaction ${tx.hash} confirmed on Arbitrum Sepolia.`,
        `Deadline ${core.formatTimestamp(deadline)} (in ${core.formatDuration(deadline - block.timestamp)}), derived as the MST deadline ${core.formatTimestamp(Number(mstLock.timelock))} minus the ${margin}s margin.`,
        `Hashlock ${short(state.swap.hashlock)} — the stored lock matched all 7 fields.`,
        "Next: Alice claims the ETH on Arbitrum, which reveals the preimage.",
      ]);
    }, "bob");
  }

  async function verifyLock(leg, expected) {
    const cfg = legChain(leg);
    const contract = new ethers.Contract(cfg.htlc, state.config.abi[cfg.contract], state.read[LEGS[leg]]);
    const record = core.decodeSwap(await contract.getSwap(legSwapId(leg)));
    const checks = [
      ["state", record.state === "Active"],
      ["sender", core.isSameAddress(record.sender, expected.sender)],
      ["recipient", core.isSameAddress(record.recipient, expected.recipient)],
      ["token", core.isSameAddress(record.token, expected.token)],
      ["amount", record.amount === expected.amount],
      ["hashlock", core.equalBytes32(record.hashlock, expected.hashlock)],
      ["timelock", record.timelock === expected.timelock],
    ];
    const failed = checks.filter((entry) => !entry[1]).map((entry) => entry[0]);
    if (failed.length > 0) throw new Error(`the stored lock differs from what was sent: ${failed.join(", ")}`);
    log("ok", `Verified the ${leg.toUpperCase()} lock: ${checks.length}/${checks.length} fields match`);
  }

  async function verifyAliceLock() {
    return run("Verify Alice's lock", async () => {
      ensureActor("bob");
      const cfg = state.config.chains.sepolia;
      const observation = state.observed.mst;
      if (!observation || !observation.swap || observation.swap.state === "None") {
        throw new Error("Alice has not locked the MST yet.");
      }
      const contract = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, state.read.sepolia);
      const record = core.decodeSwap(await contract.getSwap(state.swap.mstSwapId));
      const checks = [
        ["state", record.state === "Active"],
        ["sender", core.isSameAddress(record.sender, state.config.roles.alice)],
        ["recipient", core.isSameAddress(record.recipient, state.config.roles.bob)],
        ["token", core.isSameAddress(record.token, cfg.mst)],
        ["amount", record.amount === parseMst(state.swap.mstAmount)],
        ["hashlock", core.equalBytes32(record.hashlock, state.swap.hashlock)],
        ["timelock", record.timelock > 0],
      ];
      const failed = checks.filter((entry) => !entry[1]).map((entry) => entry[0]);
      if (failed.length > 0) {
        throw new Error(`Alice's lock does not match this page's swap (mismatched: ${failed.join(", ")}). Do not lock the ETH.`);
      }
      state.swap.mstVerified = {
        block: state.chains.sepolia ? state.chains.sepolia.blockNumber : null,
        at: Date.now(),
      };
      saveSwap();
      log("ok", `Alice's MST lock verified: ${checks.length}/${checks.length} fields match (state, sender, recipient, token, amount, hashlock, timelock)`);
      setFeedback("actor-bob-feedback", "ok", "Fingerprint match — Alice's lock is valid", [
        `Page hashlock:     ${state.swap.hashlock}`,
        `On-chain hashlock: ${record.hashlock}`,
        "The two fingerprints are identical: both are keccak256 of the same 32-byte preimage.",
        `7/7 fields match — state Active · sender Alice · recipient Bob · token MST · amount ${state.swap.mstAmount} MST · timelock ${core.formatTimestamp(record.timelock)} · hashlock.`,
        `Read from Ethereum Sepolia at block ${state.chains.sepolia ? state.chains.sepolia.blockNumber : "?"}. Bob can now safely lock the ETH on Arbitrum.`,
      ]);
    }, "bob");
  }

  async function claimEth() {
    return run("Claim ETH", async () => {
      ensureActor("alice");
      if (!state.demoAll) assertClaimable("eth");
      if (!state.swap.preimage) throw new Error("No preimage available.");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);

      log("info", "Claiming the ETH with the preimage...");
      const tx = await sendTx("arbitrum", (overrides) => htlc.claim(state.swap.ethSwapId, state.swap.preimage, overrides));
      const receipt = await tx.wait(1);
      const revealed = findClaimedPreimage(htlc, receipt) || state.swap.preimage;
      state.swap.revealedPreimage = revealed;
      saveSwap();
      log("ok", `Claimed the ETH. Preimage is now public: ${short(revealed)}`, { chain: "arbitrum", hash: tx.hash, leg: "eth" });
      setFeedback("actor-alice-feedback", "ok", "ETH claimed — the preimage is now public", [
        `Transaction ${tx.hash} confirmed on Arbitrum Sepolia.`,
        `Preimage: ${revealed}`,
        `keccak256(preimage) = ${core.hashlockFor(revealed)}.`,
        `That equals the swap hashlock ${state.swap.hashlock}, so Bob can now claim the MST with it.`,
      ]);
    }, "alice");
  }

  async function claimMst() {
    return run("Claim MST", async () => {
      ensureActor("bob");
      if (!state.demoAll) assertClaimable("mst");
      const preimage = state.swap.revealedPreimage || state.swap.preimage;
      if (!preimage) throw new Error("No preimage available yet. Alice must claim the ETH first.");
      if (!core.equalBytes32(core.hashlockFor(preimage), state.swap.hashlock)) {
        throw new Error("That preimage does not match this swap's hashlock.");
      }
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);

      log("info", "Claiming the MST with the revealed preimage...");
      const tx = await sendTx("sepolia", (overrides) => htlc.claim(state.swap.mstSwapId, preimage, overrides));
      await tx.wait(1);
      log("ok", `Claimed ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
      setFeedback("actor-bob-feedback", "ok", `MST claimed — ${state.swap.mstAmount} MST received by Bob`, [
        `Transaction ${tx.hash} confirmed on Ethereum Sepolia.`,
        `Preimage ${short(preimage)} hashes to the swap hashlock ${short(state.swap.hashlock)}.`,
        "This leg is now Claimed; claiming it again would revert with SwapNotActive and move no tokens.",
      ]);
    }, "bob");
  }

  async function refundMst() {
    return run("Refund MST", async () => {
      ensureActor("alice");
      if (!state.demoAll) assertRefundable("mst");
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);
      log("info", "Refunding the expired MST lock...");
      const tx = await sendTx("sepolia", (overrides) => htlc.refund(state.swap.mstSwapId, overrides));
      await tx.wait(1);
      log("ok", "Refunded the MST to Alice", { chain: "sepolia", hash: tx.hash, leg: "mst" });
      const observation = state.observed.mst;
      setFeedback("actor-alice-feedback", "ok", `MST refunded — ${state.swap.mstAmount} MST returned to Alice`, [
        `Transaction ${tx.hash} confirmed on Ethereum Sepolia.`,
        observation && observation.swap ? `The timelock expired at ${core.formatTimestamp(observation.swap.timelock)}.` : "",
        "The leg is now Refunded and can no longer be claimed; the escrow balance drops by this amount.",
      ].filter(Boolean));
    }, "alice");
  }

  async function refundEth() {
    return run("Refund ETH", async () => {
      ensureActor("bob");
      if (!state.demoAll) assertRefundable("eth");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);
      log("info", "Refunding the expired ETH lock...");
      const tx = await sendTx("arbitrum", (overrides) => htlc.refund(state.swap.ethSwapId, overrides));
      await tx.wait(1);
      log("ok", "Refunded the ETH to Bob", { chain: "arbitrum", hash: tx.hash, leg: "eth" });
      const observation = state.observed.eth;
      setFeedback("actor-bob-feedback", "ok", `ETH refunded — ${state.swap.ethAmount} ETH returned to Bob`, [
        `Transaction ${tx.hash} confirmed on Arbitrum Sepolia.`,
        observation && observation.swap ? `The timelock expired at ${core.formatTimestamp(observation.swap.timelock)}.` : "",
        "The leg is now Refunded and can no longer be claimed; the escrow balance drops by this amount.",
      ].filter(Boolean));
    }, "bob");
  }

  // ----------------------------------------------------- leftover locks

  async function fetchLogsChunked(provider, address, topics, fromBlock, toBlock, chunkSize = 5000) {
    const logs = [];
    for (let from = fromBlock; from <= toBlock; from += chunkSize) {
      const to = Math.min(toBlock, from + chunkSize - 1);
      let attempt = 0;
      for (;;) {
        try {
          logs.push(...(await provider.getLogs({ address, fromBlock: from, toBlock: to, topics })));
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
    return logs;
  }

  /**
   * Refund Alice's MST locks that expired without being claimed. Button equivalent
   * of `npm run recover -- --chain sepolia --execute`: scans the escrow's Locked
   * events (last ~7 days) and refunds every Active+expired lock sent by Alice.
   */
  async function recoverHeldMst() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await recoverHeldMstAction();
    } catch (error) {
      const message = describeError(error);
      setFeedback("recover-feedback", "err", "Could not recover the held MST", [
        message,
        "You can also run: npm run recover -- --chain sepolia --execute",
      ]);
      log("err", `Recover held MST: ${message}`);
    } finally {
      state.busy = false;
      render();
      await refresh();
    }
  }

  async function recoverHeldMstAction() {
    if (!state.walletProvider) throw new Error("Connect MetaMask first.");
    ensureActor("alice");
    const cfg = state.config.chains.sepolia;
    if (state.chainId !== cfg.chainId) {
      log("info", `Switching MetaMask to ${cfg.label}...`);
      await switchNetwork("sepolia");
    }
    const signer = await ensureSigner("sepolia");
    const provider = state.read.sepolia;
    const latest = await provider.getBlockNumber();
    const latestBlock = await provider.getBlock(latest);
    let scannedTo = latest;
    let scannedFrom = latest;
    const htlcRead = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, provider);
    const htlcSigner = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);
    const seen = new Set();
    const refundable = [];
    const waiting = [];

    setFeedback("recover-feedback", "info", "Scanning the escrow for held MST...", [
      "Reading Locked events from newest to oldest (2,000 → 10,000 → 50,000 blocks).",
    ]);

    for (const lookback of [2000, 10000, 50000]) {
      const fromBlock = Math.max(0, latest - lookback);
      if (fromBlock > scannedTo) continue;
      scannedFrom = fromBlock;
      const logs = await fetchLogsChunked(provider, cfg.htlc, [LOCKED_TOPIC], fromBlock, scannedTo, 2000);
      for (const entry of logs) {
        let parsed;
        try {
          parsed = htlcRead.interface.parseLog(entry);
        } catch {
          continue;
        }
        if (!parsed || parsed.name !== "Locked") continue;
        const swapId = parsed.args.swapId;
        if (seen.has(swapId)) continue;
        seen.add(swapId);
        const record = core.decodeSwap(await htlcRead.getSwap(swapId));
        if (record.state !== "Active") continue;
        if (!core.isSameAddress(record.sender, state.config.roles.alice)) continue;
        if (Number(record.timelock) <= latestBlock.timestamp) refundable.push({ swapId, record });
        else waiting.push({ swapId, record });
      }
      scannedTo = fromBlock - 1;
      if (refundable.length > 0 || waiting.length > 0) break;
      if (fromBlock === 0) break;
    }

    if (refundable.length === 0) {
      if (waiting.length === 0) {
        setFeedback("recover-feedback", "info", "No held MST found", [
          `Checked ${seen.size} lock(s) in blocks ${scannedFrom}…${latest}; none is an Active lock from Alice.`,
          "If the escrow still shows a balance, run: npm run recover -- --chain sepolia --execute",
        ]);
      } else {
        setFeedback("recover-feedback", "warn", "A lock is held, but it has not expired yet", waiting.map((entry) =>
          `${short(entry.swapId)}: ${ethers.formatUnits(entry.record.amount, state.decimals)} MST, refund unlocks at ${core.formatTimestamp(Number(entry.record.timelock))}.`
        ));
      }
      return;
    }

    let refunded = 0;
    let total = 0n;
    const lines = [];
    const failures = [];
    for (const entry of refundable) {
      try {
        const tx = await sendTx("sepolia", (overrides) => htlcSigner.refund(entry.swapId, overrides));
        await tx.wait(1);
        refunded += 1;
        total += entry.record.amount;
        lines.push(`${ethers.formatUnits(entry.record.amount, state.decimals)} MST · transaction ${tx.hash}`);
        log("ok", `Refunded ${ethers.formatUnits(entry.record.amount, state.decimals)} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
      } catch (error) {
        failures.push(`${short(entry.swapId)}: ${describeError(error)}`);
      }
    }

    if (refunded === 0) {
      setFeedback("recover-feedback", "err", "No refund could be completed", failures);
      return;
    }
    setFeedback("recover-feedback", "ok", `Refunded ${refunded} lock(s) — ${ethers.formatUnits(total, state.decimals)} MST returned to Alice`, [
      ...lines,
      waiting.length > 0 ? `${waiting.length} lock(s) are not expired yet and were left alone.` : "",
      failures.length > 0 ? `Failed: ${failures.join("; ")}` : "",
    ].filter(Boolean));
  }
  // ------------------------------------------------------------- render

  function chainHasSwap() {
    return ["mst", "eth"].some((leg) => {
      const observation = state.observed[leg];
      return observation && observation.swap && observation.swap.state !== "None";
    });
  }

  function chainReadOk(leg) {
    const chain = state.chains[LEGS[leg]];
    const observation = state.observed[leg];
    return Boolean(chain && !chain.error && observation && !observation.error && observation.swap);
  }

  function onNetwork(chainName) {
    const cfg = state.config.chains[chainName];
    return state.chainId !== null && state.chainId === cfg.chainId;
  }

  function networkTitle(chainName, action) {
    return onNetwork(chainName)
      ? action
      : `Switch MetaMask to ${state.config.chains[chainName].label} with the header button first`;
  }

  function isShown(id) {
    return !$(id).classList.contains("hidden");
  }

  function showAction(id, visible, enabled, title) {
    const button = $(id);
    button.classList.toggle("hidden", !visible);
    button.disabled = !visible || !enabled;
    button.title = title || "";
  }

  function clearFeedback() {
    for (const id of ["global-feedback", "actor-alice-feedback", "actor-bob-feedback"]) {
      const box = $(id);
      box.classList.add("hidden");
      box.textContent = "";
    }
  }

  /** Prominent result banner directly under the buttons that produced it. */
  function setFeedback(targetId, kind, title, lines = []) {
    const box = $(targetId);
    if (!box) return;
    box.className = `feedback ${kind}`;
    box.textContent = "";
    const heading = document.createElement("strong");
    heading.textContent = title;
    box.appendChild(heading);
    for (const line of lines) {
      if (!line) continue;
      const row = document.createElement("div");
      row.textContent = line;
      box.appendChild(row);
    }
    if (typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function render() {
    if (!state.config) return;
    renderWallet();
    renderNetworkButtons();
    renderSecret();
    renderActors();
    renderLeg("mst");
    renderLeg("eth");
    renderChains();
    $("next-action").textContent = nextActionHint();
    $("connect").disabled = state.accounts.length > 0 || !window.ethereum;
    $("disconnect").classList.toggle("hidden", state.accounts.length === 0);
    $("refresh").disabled = state.busy;
    $("recover-mst").disabled = state.busy;

    const locked = Boolean(chainHasSwap());
    for (const id of ["mst-amount", "eth-amount", "timelock", "margin"]) $(id).disabled = locked;
    $("generate").disabled = state.busy || locked;
    $("generate").title = locked ? "This swap already exists on-chain; press Reset to start a new one" : "";
  }

  function renderWallet() {
    const wallet = $("wallet-status");
    const network = $("network-status");
    if (!state.walletProvider) {
      wallet.textContent = "not connected";
      wallet.className = "pill muted";
    } else if (isAuthorised(state.activeRole)) {
      wallet.textContent = `${capitalise(state.activeRole)} · ${short(state.config.roles[state.activeRole])}`;
      wallet.className = "pill good";
    } else {
      wallet.textContent = `${capitalise(state.activeRole)} · not authorised`;
      wallet.className = "pill bad";
    }
    if (state.chainId) {
      const known = Object.values(state.config.chains).find((cfg) => cfg.chainId === state.chainId);
      network.textContent = known ? known.label : `chain ${state.chainId}`;
      network.className = known ? "pill good" : "pill bad";
    } else {
      network.textContent = "no network";
      network.className = "pill muted";
    }
  }

  function renderNetworkButtons() {
    const sepolia = state.config.chains.sepolia;
    const arbitrum = state.config.chains.arbitrum;
    $("switch-sepolia").disabled = state.chainId === sepolia.chainId;
    $("switch-arbitrum").disabled = state.chainId === arbitrum.chainId;
    $("switch-sepolia").title = state.chainId === sepolia.chainId ? "MetaMask is already on Sepolia" : `Ask MetaMask to switch to ${sepolia.label}`;
    $("switch-arbitrum").title = state.chainId === arbitrum.chainId ? "MetaMask is already on Arbitrum" : `Ask MetaMask to switch to ${arbitrum.label}`;
  }

  function renderSecret() {
    const swap = state.swap;
    const node = $("preimage");
    if (swap && swap.revealedPreimage) {
      node.textContent = `${swap.revealedPreimage} (public on-chain)`;
    } else if (swap && swap.preimage) {
      node.textContent = state.revealPreimage
        ? swap.preimage
        : `${swap.preimage.slice(0, 10)}…${swap.preimage.slice(-6)} (hidden)`;
    } else {
      node.textContent = "—";
    }
    $("reveal").classList.toggle("hidden", !(swap && swap.preimage));
    $("reveal").textContent = state.revealPreimage ? "hide" : "reveal";
    $("hashlock").textContent = (swap && swap.hashlock) || "—";
    $("mst-swap-id").textContent = (swap && swap.mstSwapId) || "—";
    $("eth-swap-id").textContent = (swap && swap.ethSwapId) || "—";
  }

  function renderActors() {
    const sepolia = state.chains.sepolia;
    const arbitrum = state.chains.arbitrum;
    const me = state.activeRole;
    const mst = state.observed.mst;
    const eth = state.observed.eth;
    const mstLabels = mst && mst.swap ? mst.labels : null;
    const ethLabels = eth && eth.swap ? eth.labels : null;
    const mstExists = Boolean(mst && mst.swap && mst.swap.state !== "None");
    const ethExists = Boolean(eth && eth.swap && eth.swap.state !== "None");
    const mstLockedHere = Boolean(state.swap.mstDeadline);
    const ethLockedHere = Boolean(state.swap.ethDeadline);
    const allowanceShort = Boolean(
      mst && mst.allowance !== null && mst.allowance < parseMst(state.swap.mstAmount)
    );

    for (const role of ["alice", "bob"]) {
      $(`actor-${role}-badge`).classList.toggle("hidden", me !== role);
      $(`actor-${role}`).classList.toggle("active", me === role);
      $(`act-as-${role}`).classList.toggle("hidden", me === role);
      $(`actor-${role}-address`).textContent = state.config.roles[role] || "not configured in .env";
      const ethSep = sepolia && sepolia.balances ? sepolia.balances[role].eth : null;
      const ethArb = arbitrum && arbitrum.balances ? arbitrum.balances[role].eth : null;
      const mstBal = sepolia && sepolia.balances ? sepolia.balances[role].mst : null;
      $(`actor-${role}-eth-sepolia`).textContent = ethSep === null ? "—" : `${ethers.formatEther(ethSep)} ETH`;
      $(`actor-${role}-eth-arbitrum`).textContent = ethArb === null ? "—" : `${ethers.formatEther(ethArb)} ETH`;
      $(`actor-${role}-mst`).textContent = mstBal === null ? "—" : `${ethers.formatUnits(mstBal, state.decimals)} MST`;
    }

    const activeAlice = me === "alice";
    const activeBob = me === "bob";
    const mstReadOk = chainReadOk("mst");
    const ethReadOk = chainReadOk("eth");

    if (state.demoAll) {
      // Demo mode: show every action and let the contracts decide. Invalid
      // attempts are sent and revert with their custom error (for example a
      // second claim reverts with SwapNotActive), which is the point of the demo.
      const ready = Boolean(state.swap && state.swap.hashlock);
      for (const id of ["approve-mst", "lock-mst", "claim-eth", "refund-mst", "verify-mst", "lock-eth", "claim-mst", "refund-eth"]) {
        showAction(id, true, ready && !state.busy, ready ? "Demo: attempt this action even if it is not valid right now" : "Generate a swap first");
      }
    } else {
      // Alice's actions live in Alice's card.
      const canLockMst = mstReadOk && !mstExists && !mstLockedHere;
      showAction("approve-mst", activeAlice && canLockMst && allowanceShort, !state.busy && onNetwork("sepolia"),
        networkTitle("sepolia", "Approve the escrow to pull the MST"));
      showAction("lock-mst", activeAlice && canLockMst && !allowanceShort, !state.busy && onNetwork("sepolia"),
        networkTitle("sepolia", "Lock the MST for Bob"));
      showAction("claim-eth", activeAlice && ethReadOk && Boolean(ethLabels && ethLabels.claimable) && Boolean(state.swap.preimage), !state.busy && onNetwork("arbitrum"),
        networkTitle("arbitrum", "Claim the ETH, revealing the preimage"));
      showAction("refund-mst", activeAlice && mstReadOk && Boolean(mstLabels && mstLabels.refundable), !state.busy && onNetwork("sepolia"),
        networkTitle("sepolia", "Refund the expired MST lock"));

      // Bob's actions live in Bob's card.
      showAction("verify-mst", activeBob && mstReadOk && mstExists && mstLabels.active && !state.swap.ethDeadline, !state.busy && onNetwork("sepolia"),
        networkTitle("sepolia", "Read Alice's lock and compare all parameters"));
      showAction("lock-eth", activeBob && ethReadOk && !ethExists && !ethLockedHere, !state.busy && onNetwork("arbitrum"),
        networkTitle("arbitrum", "Lock the ETH for Alice"));
      showAction("claim-mst", activeBob && mstReadOk && Boolean(mstLabels && mstLabels.claimable) && Boolean(state.swap.revealedPreimage), !state.busy && onNetwork("sepolia"),
        networkTitle("sepolia", "Claim the MST with the revealed preimage"));
      showAction("refund-eth", activeBob && ethReadOk && Boolean(ethLabels && ethLabels.refundable), !state.busy && onNetwork("arbitrum"),
        networkTitle("arbitrum", "Refund the expired ETH lock"));
    }

    // A short note explains why a card has no actionable button.
    const aliceHasAction = isShown('approve-mst') || isShown('lock-mst') || isShown('claim-eth') || isShown('refund-mst');
    const bobHasAction = isShown('verify-mst') || isShown('lock-eth') || isShown('claim-mst') || isShown('refund-eth');
    $(`actor-alice-note`).textContent = actorNote("alice", {
      active: activeAlice,
      demo: state.demoAll,
      hasAction: aliceHasAction,
      authorised: isAuthorised("alice"),
      hasWallet: Boolean(state.walletProvider),
      note: state.swap.mstVerified && activeBob
        ? `Alice's lock verified at block ${state.swap.mstVerified.block ?? "?"} · hashlock matches`
        : "",
      waitingOn: "Bob",
    });
    $(`actor-bob-note`).textContent = actorNote("bob", {
      active: activeBob,
      demo: state.demoAll,
      hasAction: bobHasAction,
      authorised: isAuthorised("bob"),
      hasWallet: Boolean(state.walletProvider),
      note: state.swap.mstVerified
        ? `Alice's lock verified at block ${state.swap.mstVerified.block ?? "?"} · hashlock matches`
        : "",
      waitingOn: "Alice",
    });
  }

  function actorNote(role, options) {
    if (options.demo) return "Demo mode: every action is clickable; invalid attempts are sent and revert on-chain (see the activity log).";
    if (!options.active) return `Press “Act as ${capitalise(role)}” to sign this account's next step.`;
    if (!options.hasWallet) return "Connect MetaMask to sign as this account.";
    if (!options.authorised) return "MetaMask has not authorised this account yet — press “Act as…” and tick it in the popup.";
    if (options.note) return options.note;
    const needed = nextActionChain(role);
    if (needed && !onNetwork(needed)) return `Switch MetaMask to ${state.config.chains[needed].label} to act here.`;
    if (options.hasAction) return "";
    return `Waiting for ${options.waitingOn}.`;
  }

  function nextActionChain(role) {
    const mst = state.observed.mst;
    const eth = state.observed.eth;
    const mstLabels = mst && mst.swap ? mst.labels : null;
    const ethLabels = eth && eth.swap ? eth.labels : null;
    const mstState = mst && mst.swap ? mst.swap.state : null;
    const ethState = eth && eth.swap ? eth.swap.state : null;

    if (role === "alice") {
      if (mstState === null || mstState === "None") return "sepolia";
      if (mstLabels && mstLabels.refundable) return "sepolia";
      if (ethLabels && ethLabels.claimable) return "arbitrum";
      if (ethState === "Claimed") return "arbitrum";
      return null;
    }

    if (mstLabels && mstLabels.claimable && state.swap.revealedPreimage) return "sepolia";
    if (ethState === null || ethState === "None") return "arbitrum";
    if (ethLabels && ethLabels.refundable) return "arbitrum";
    if (mstLabels && mstLabels.refundable) return "sepolia";
    return null;
  }
  function renderLeg(leg) {
    const cfg = legChain(leg);
    const observation = state.observed[leg];
    const chain = state.chains[LEGS[leg]];
    const swap = state.swap;

    const node = $(`${leg}-state`);
    let text = "not read";
    let cls = "state";
    if (observation && observation.error) {
      text = "read error";
      cls += " expired";
    } else if (observation && observation.swap) {
      const record = observation.swap;
      if (record.state === "None") {
        text = "not created";
      } else if (record.state === "Active") {
        text = observation.labels.expired ? "Active · expired" : "Active";
        cls += observation.labels.expired ? " expired" : " active";
      } else {
        text = record.state;
        cls += " claimed";
      }
    }
    node.textContent = text;
    node.className = cls;

    if (observation && observation.swap && observation.swap.state !== "None") {
      const record = observation.swap;
      $(`${leg}-leg-amount`).textContent = leg === "mst"
        ? `${ethers.formatUnits(record.amount, state.decimals)} MST`
        : `${ethers.formatEther(record.amount)} ETH`;
      $(`${leg}-leg-roles`).textContent = `${roleLabel(record.sender)} → ${roleLabel(record.recipient)}`;
      const matches = swap.hashlock && core.equalBytes32(record.hashlock, swap.hashlock);
      $(`${leg}-leg-hashlock`).textContent = matches ? "matches this page's hashlock" : "DOES NOT MATCH";
    } else {
      $(`${leg}-leg-amount`).textContent = leg === "mst"
        ? `${swap.mstAmount} MST (planned)`
        : `${swap.ethAmount} ETH (planned)`;
      $(`${leg}-leg-roles`).textContent = leg === "mst"
        ? `${roleLabel(state.config.roles.alice)} → ${roleLabel(state.config.roles.bob)}`
        : `${roleLabel(state.config.roles.bob)} → ${roleLabel(state.config.roles.alice)}`;
      $(`${leg}-leg-hashlock`).textContent = "not locked yet";
    }
    $(`${leg}-leg-contract`).innerHTML = addressLink(cfg.explorer, cfg.htlc, cfg.label);
    renderDeadline(leg);

    const hash = state.lastTx[leg];
    if (observation && observation.swap && observation.swap.state === "Claimed") {
      $(`${leg}-tx`).innerHTML = hash ? `claimed · ${txLink(leg, hash)}` : "claimed";
    } else if (observation && observation.swap && observation.swap.state === "Refunded") {
      $(`${leg}-tx`).innerHTML = hash ? `refunded · ${txLink(leg, hash)}` : "refunded";
    } else if (chain && chain.blockNumber) {
      $(`${leg}-tx`).textContent = `observed at block ${chain.blockNumber}${chain.lastError ? " · last read failed, retrying" : ""}`;
    } else {
      $(`${leg}-tx`).textContent = "";
    }
  }

  function renderDeadline(leg) {
    const observation = state.observed[leg];
    const chain = state.chains[LEGS[leg]];
    const node = $(`${leg}-leg-deadline`);
    if (!chain || chain.error || !observation || observation.error) {
      node.textContent = "—";
      return;
    }
    if (observation.swap && observation.swap.state !== "None") {
      node.textContent = deadlineText(observation, chain);
      return;
    }
    const planned = leg === "mst" ? state.swap.mstDeadline : state.swap.ethDeadline;
    node.textContent = planned ? `planned ${core.formatTimestamp(planned)}` : "set when the lock is created";
  }

  function deadlineText(observation, chain) {
    const elapsed = (Date.now() - chain.observedAt) / 1000;
    const now = chain.blockTimestamp + elapsed;
    const left = observation.swap.timelock - now;
    const base = core.formatTimestamp(observation.swap.timelock);
    return left > 0
      ? `${base} · in ${core.formatDuration(left)}`
      : `${base} · expired ${core.formatDuration(-left)} ago`;
  }

  function renderCountdowns() {
    for (const leg of Object.keys(LEGS)) {
      const observation = state.observed[leg];
      const chain = state.chains[LEGS[leg]];
      if (!observation || observation.error || !observation.swap || observation.swap.state === "None") continue;
      if (!chain || chain.error) continue;
      $(`${leg}-leg-deadline`).textContent = deadlineText(observation, chain);
    }
  }

  function renderChains() {
    for (const name of ["sepolia", "arbitrum"]) {
      const cfg = state.config.chains[name];
      const chain = state.chains[name];
      $(`chain-${name}-id`).textContent = `${cfg.chainId} (0x${cfg.chainId.toString(16)})`;

      const fields = name === "sepolia"
        ? ["block", "time", "basefee", "escrow", "escrow-balance", "token", "token-balance"]
        : ["block", "time", "basefee", "escrow", "escrow-balance"];

      if (!chain || chain.error) {
        for (const field of fields) {
          const node = $(`chain-${name}-${field}`);
          if (node) node.textContent = chain && chain.error ? "read error" : "—";
        }
        $(`chain-${name}-status`).textContent = chain && chain.error ? `retrying: ${chain.error}` : "waiting";
        continue;
      }

      $(`chain-${name}-block`).textContent = `#${chain.blockNumber}`;
      $(`chain-${name}-time`).textContent = core.formatTimestamp(chain.blockTimestamp);
      $(`chain-${name}-basefee`).textContent = chain.baseFee ? `${ethers.formatUnits(chain.baseFee, "gwei")} gwei` : "n/a";
      $(`chain-${name}-escrow`).innerHTML = addressLink(cfg.explorer, cfg.htlc, cfg.contract);
      $(`chain-${name}-escrow-balance`).textContent = chain.escrowEth === null ? "—" : `${ethers.formatEther(chain.escrowEth)} ETH`;
      if (name === "sepolia") {
        $(`chain-${name}-token`).innerHTML = addressLink(cfg.explorer, cfg.mst, "MST");
        $(`chain-${name}-token-balance`).textContent = chain.mstEscrow === null ? "—" : `${ethers.formatUnits(chain.mstEscrow, state.decimals)} MST`;
      }

      const age = Math.max(0, Math.round((Date.now() - chain.observedAt) / 1000));
      if (chain.lastError) {
        const retryIn = state.nextRetryAt ? Math.max(0, Math.round((state.nextRetryAt - Date.now()) / 1000)) : null;
        $(`chain-${name}-status`).textContent =
          `${age}s ago · retrying${retryIn !== null ? ` in ${retryIn}s` : ""} (${chain.lastError})`;
      } else {
        $(`chain-${name}-status`).textContent = `${age}s ago`;
      }
    }
  }

  function nextActionHint() {
    if (!state.config) return "Loading configuration...";
    if (!state.swap || !state.swap.preimage) return "Click “Generate new secret” to create the preimage, hashlock and both swap ids.";
    if (!state.config.chains.sepolia.htlc || !state.config.chains.arbitrum.htlc) {
      return "Deploy both escrows first (npm run deploy), then restart the UI.";
    }
    if (!state.walletProvider) return "Connect MetaMask, then pick Alice or Bob in section 3.";

    const me = state.activeRole;
    const asRole = (role, sentence) => me === role
      ? sentence
      : `Press “Act as ${capitalise(role)}”, then: ${sentence}`;

    const mst = state.observed.mst;
    const eth = state.observed.eth;
    const mstLabels = mst && mst.swap ? mst.labels : null;
    const ethLabels = eth && eth.swap ? eth.labels : null;
    const mstState = mst && mst.swap ? mst.swap.state : null;
    const ethState = eth && eth.swap ? eth.swap.state : null;

    if (mstLabels && mstLabels.claimable && state.swap.revealedPreimage && ethState !== "Active") {
      return asRole("bob", `Bob: claim the MST on Sepolia${onNetwork("sepolia") ? "." : " — switch MetaMask to Sepolia first."}`);
    }

    if (!mstLabels || !ethLabels) {
      const failing = [];
      if (!mstLabels) failing.push(mst && mst.error ? `Ethereum Sepolia (${mst.error})` : "Ethereum Sepolia");
      if (!ethLabels) failing.push(eth && eth.error ? `Arbitrum Sepolia (${eth.error})` : "Arbitrum Sepolia");
      return `Cannot read ${failing.join(" and ")} yet — retrying automatically, see the Chains section.`;
    }

    const need = (chainName) => (onNetwork(chainName) ? "" : ` Switch MetaMask to ${state.config.chains[chainName].label} first (header button).`);

    if (mstState === "None" && ethState === "None") {
      return asRole("alice", `Alice: approve ${state.swap.mstAmount} MST, then lock it on Sepolia.${need("sepolia")}`);
    }
    if (mstLabels.claimable && ethState === "None") {
      return asRole("bob", `Bob: verify Alice's lock, then lock ${state.swap.ethAmount} ETH on Arbitrum.${need("arbitrum")}`);
    }
    if (ethLabels.claimable && mstState === "Active") {
      return asRole("alice", `Alice: claim the ETH on Arbitrum; that publishes the preimage for Bob.${need("arbitrum")}`);
    }
    if (ethState === "Claimed" && mstLabels.claimable) {
      return asRole("bob", `Bob: claim the MST on Sepolia with the revealed preimage.${need("sepolia")}`);
    }
    if (mstState === "Claimed" && ethState === "Claimed") {
      return "Swap complete: both legs are claimed. Press Reset to run another swap.";
    }
    if (mstLabels.refundable || ethLabels.refundable) {
      const legs = [mstLabels.refundable ? "the MST (as Alice)" : null, ethLabels.refundable ? "the ETH (as Bob)" : null].filter(Boolean);
      return `Timelock expired: refund ${legs.join(" or ")} — press the matching “Act as” button first.`;
    }
    if (mstState === "Refunded" || ethState === "Refunded") {
      return "This swap was (partly) refunded. Reset to run another swap.";
    }
    return "Waiting for the next step.";
  }

  // -------------------------------------------------------------- events

  function wireEvents() {
    $("connect").addEventListener("click", connect);
    $("disconnect").addEventListener("click", () => guard("Disconnect", disconnect));
    $("switch-sepolia").addEventListener("click", () => guard("Switch network", () => switchNetwork("sepolia")));
    $("switch-arbitrum").addEventListener("click", () => guard("Switch network", () => switchNetwork("arbitrum")));
    $("act-as-alice").addEventListener("click", () => guard("Act as Alice", () => actAs("alice"), "actor-alice-feedback"));
    $("act-as-bob").addEventListener("click", () => guard("Act as Bob", () => actAs("bob"), "actor-bob-feedback"));
    $("show-all-actions").addEventListener("change", (event) => {
      state.demoAll = event.target.checked;
      savePrefs();
      render();
      log("info", state.demoAll
        ? "Demo mode: every action is shown; invalid attempts are sent and revert on-chain."
        : "Normal mode: only the acting account's valid actions are shown.");
      setFeedback("global-feedback", "info", state.demoAll ? "Demo mode enabled" : "Normal mode restored", [
        state.demoAll
          ? "All eight buttons are visible and clickable; the page switches the actor and network for you, then the contract accepts or reverts each attempt."
          : "Only the acting account's currently valid actions are shown.",
      ]);
    });
    $("generate").addEventListener("click", generateSwap);
    $("reset").addEventListener("click", resetSwap);
    $("refresh").addEventListener("click", refreshWithFeedback);
    $("recover-mst").addEventListener("click", recoverHeldMst);
    $("reveal").addEventListener("click", () => {
      state.revealPreimage = !state.revealPreimage;
      render();
      setFeedback("global-feedback", "info", state.revealPreimage ? "Preimage shown" : "Preimage hidden", [
        state.revealPreimage
          ? `The secret is ${state.swap.preimage}. Its keccak256 must equal the hashlock ${short(state.swap.hashlock)}.`
          : "The preimage is hidden again; it stays in this browser's localStorage.",
      ]);
    });

    $("approve-mst").addEventListener("click", approveMst);
    $("lock-mst").addEventListener("click", lockMst);
    $("claim-eth").addEventListener("click", claimEth);
    $("refund-mst").addEventListener("click", refundMst);
    $("verify-mst").addEventListener("click", verifyAliceLock);
    $("lock-eth").addEventListener("click", lockEth);
    $("claim-mst").addEventListener("click", claimMst);
    $("refund-eth").addEventListener("click", refundEth);

    for (const id of ["mst-amount", "eth-amount", "timelock", "margin"]) {
      $(id).addEventListener("change", syncInputsToSwap);
    }

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", () => {
        refreshWallet().catch((error) => log("err", `Wallet refresh failed: ${describeError(error)}`));
      });
      window.ethereum.on("chainChanged", () => {
        refreshWallet().catch((error) => log("err", `Wallet refresh failed: ${describeError(error)}`));
      });
    }
  }

  function guard(label, action, targetId = "global-feedback") {
    Promise.resolve()
      .then(action)
      .catch((error) => {
        const message = describeError(error);
        setFeedback(targetId, "err", `${label} failed`, [message]);
        log("err", `${label}: ${message}`);
      });
  }

  function generateSwap() {
    try {
      const amounts = readInputs();
      const preimage = core.randomBytes32();
      state.swap = {
        preimage,
        hashlock: core.hashlockFor(preimage),
        mstSwapId: core.randomBytes32(),
        ethSwapId: core.randomBytes32(),
        ...amounts,
        mstDeadline: null,
        ethDeadline: null,
        revealedPreimage: null,
        mstVerified: null,
      };
      state.revealPreimage = false;
      state.observed = {};
      state.lastTx = {};
      saveSwap();
      applySwapToInputs();
      render();
      refresh();
      log("info", `New swap ready. Hashlock ${short(state.swap.hashlock)}`);
      clearFeedback();
      setFeedback("global-feedback", "ok", "New swap generated", [
        `Hashlock ${state.swap.hashlock}.`,
        `${state.swap.mstAmount} MST will be locked on Ethereum Sepolia and ${state.swap.ethAmount} ETH on Arbitrum Sepolia for the same secret.`,
        "The preimage stays hidden in this browser until Alice claims the ETH. Next: Approve MST as Alice.",
      ]);
    } catch (error) {
      const message = error.message;
      log("err", message);
      setFeedback("global-feedback", "err", "Cannot generate the swap", [message]);
    }
  }

  function resetSwap() {
    if (chainHasSwap() && !window.confirm("A swap already exists on-chain. Reset the page anyway? Its preimage and ids will be forgotten here (the chain keeps them).")) {
      return;
    }
    state.swap = null;
    state.observed = {};
    state.lastTx = {};
    state.revealPreimage = false;
    try {
      state.swap = defaultSwap();
      applySwapToInputs();
      saveSwap();
    } catch {
      // Defaults unavailable; the inputs keep their values.
    }
    render();
    log("info", "Reset. Press “Generate new secret” for a new swap.");
    clearFeedback();
    setFeedback("global-feedback", "info", "Reset", [
      "The page forgot the previous preimage and swap ids; the chain is unchanged.",
      `Defaults restored: ${state.swap ? state.swap.mstAmount : "?"} MST, ${state.swap ? state.swap.ethAmount : "?"} ETH.`,
    ]);
  }

  function readInputs() {
    const mstAmount = $("mst-amount").value.trim();
    const ethAmount = $("eth-amount").value.trim();
    const timelockSeconds = Number($("timelock").value);
    const marginSeconds = Number($("margin").value);
    if (!(Number(mstAmount) > 0)) throw new Error("MST amount must be a positive number.");
    if (!(Number(ethAmount) > 0)) throw new Error("ETH amount must be a positive number.");
    if (!Number.isFinite(timelockSeconds) || timelockSeconds < 60) throw new Error("The timelock must be at least 60 seconds.");
    if (!Number.isFinite(marginSeconds) || marginSeconds < 60) throw new Error("The MST margin must be at least 60 seconds.");
    return { mstAmount, ethAmount, timelockSeconds, marginSeconds };
  }

  function syncInputsToSwap() {
    if (!state.swap) return;
    try {
      Object.assign(state.swap, readInputs());
      saveSwap();
      render();
    } catch (error) {
      log("err", error.message);
    }
  }

  function applySwapToInputs() {
    const swap = state.swap || defaultSwap();
    $("mst-amount").value = swap.mstAmount;
    $("eth-amount").value = swap.ethAmount;
    $("timelock").value = swap.timelockSeconds;
    $("margin").value = swap.marginSeconds;
  }

  function defaultSwap() {
    const defaults = state.config.defaults;
    return {
      preimage: null,
      hashlock: null,
      mstSwapId: null,
      ethSwapId: null,
      mstAmount: defaults.mstAmount,
      ethAmount: defaults.ethAmount,
      timelockSeconds: defaults.timelockSeconds,
      marginSeconds: defaults.marginSeconds,
      mstDeadline: null,
      ethDeadline: null,
      revealedPreimage: null,
      mstVerified: null,
    };
  }

  // ------------------------------------------------------------- storage

  function saveSwap() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.swap));
    } catch {
      // Private mode: the swap works, it is just not remembered.
    }
  }

  function restoreSwap() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      state.swap = stored ? JSON.parse(stored) : defaultSwap();
    } catch {
      state.swap = defaultSwap();
    }
    if (!state.swap || typeof state.swap !== "object" || !state.swap.hashlock) {
      state.swap = defaultSwap();
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ role: state.activeRole, demoAll: state.demoAll }));
    } catch {
      // Ignore storage failures.
    }
  }

  function loadPrefs() {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (stored.role === "alice" || stored.role === "bob") {
        state.activeRole = stored.role;
        state.hasStoredRole = true;
      }
      if (typeof stored.demoAll === "boolean") state.demoAll = stored.demoAll;
    } catch {
      // Keep defaults.
    }
  }

  // ------------------------------------------------------------- helpers

  function roleFor(address) {
    if (!address) return null;
    const roles = state.config.roles;
    if (roles.alice && core.isSameAddress(address, roles.alice)) return "alice";
    if (roles.bob && core.isSameAddress(address, roles.bob)) return "bob";
    return null;
  }

  function roleLabel(address) {
    const role = roleFor(address);
    if (role) return capitalise(role);
    return address ? short(address) : "?";
  }

  function capitalise(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : text;
  }

  function short(value) {
    if (!value) return "—";
    const text = String(value);
    return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
  }

  function networkLabel(chainId) {
    const known = Object.values(state.config.chains).find((cfg) => cfg.chainId === chainId);
    return known ? known.label : `chain ${chainId}`;
  }

  function parseMst(amount) {
    return ethers.parseUnits(String(amount), state.decimals);
  }

  function parseEth(amount) {
    return ethers.parseEther(String(amount));
  }

  function addressLink(explorer, address, label) {
    if (!address) return "not configured";
    return `<a href="${explorer}/address/${address}" target="_blank" rel="noreferrer">${label} ${short(address)}</a>`;
  }

  function txLink(leg, hash) {
    const cfg = legChain(leg);
    return `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noreferrer">${short(hash)}</a>`;
  }

  function findClaimedPreimage(contract, receipt) {
    for (const entry of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(entry);
        if (parsed && parsed.name === "Claimed") return parsed.args.preimage;
      } catch {
        // Log from another contract.
      }
    }
    return null;
  }

  function describeError(error) {
    if (!error) return "unknown error";
    if (error.code === 4001 || (error.info && error.info.error && error.info.error.code === 4001)) {
      return "rejected in MetaMask";
    }
    const revert = error.revert || (error.info && error.info.error && error.info.error.data && error.info.error.data.revert);
    if (revert && revert.name) {
      const args = Array.isArray(revert.args) ? revert.args.map(String).join(", ") : "";
      return `${revert.name}${args ? `(${args})` : ""}`;
    }
    const rpcMessage = error.info && error.info.error && error.info.error.message;
    if (rpcMessage) return rpcMessage;
    const innerMessage = error.error && error.error.message;
    if (innerMessage) return innerMessage;
    if (/missing response for request/i.test(error.message || "")) {
      return "no response from the RPC proxy (the provider is busy or rate limiting)";
    }
    if (error.shortMessage) return error.reason ? `${error.shortMessage}: ${error.reason}` : error.shortMessage;
    return error.message || String(error);
  }

  function log(kind, message, tx) {
    const list = $("log");
    const item = document.createElement("li");
    item.className = kind;
    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString();
    item.appendChild(time);
    item.appendChild(document.createTextNode(message));
    if (tx && tx.hash) {
      if (tx.leg) state.lastTx[tx.leg] = tx.hash;
      const cfg = state.config.chains[tx.chain];
      const link = document.createElement("a");
      link.href = `${cfg.explorer}/tx/${tx.hash}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${short(tx.hash)} ↗`;
      item.appendChild(link);
    }
    list.insertBefore(item, list.firstChild);
    while (list.children.length > 60) list.removeChild(list.lastChild);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();












