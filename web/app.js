// Task C: single-page browser UI for the cross-chain HTLC swap.
//
// Reads go through the local server's read-only RPC proxy, so both chains can be
// observed at the same time. Writes go through MetaMask on the chain the action
// belongs to. The protocol rules are shared with the CLI via /shared/htlc-core.js.
(function () {
  const { ethers } = window;
  const core = window.HtlcCore.create(ethers);
  const LEGS = { mst: "sepolia", eth: "arbitrum" };
  const STORAGE_KEY = "comp5521-htlc-swap-v1";

  const state = {
    config: null,
    account: null,
    chainId: null,
    signer: null,
    walletProvider: null,
    read: {},
    swap: null,
    observed: {},
    lastTx: {},
    decimals: 18,
    busy: false,
    revealPreimage: false,
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
    applySwapToInputs();
    wireEvents();
    render();

    if (state.swap && state.swap.preimage) refresh();
    loadDecimals();
    setInterval(() => { if (state.swap && state.swap.preimage) refresh(); }, 12000);
    setInterval(renderCountdowns, 1000);

    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_accounts" });
        if (accounts && accounts[0]) await refreshWallet(accounts[0]);
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

  async function refreshWallet(account) {
    state.walletProvider = new ethers.BrowserProvider(window.ethereum);
    state.signer = await state.walletProvider.getSigner();
    state.account = account || (await state.signer.getAddress());
    state.chainId = Number((await state.walletProvider.getNetwork()).chainId);
    render();
  }

  async function connect() {
    if (!window.ethereum) {
      log("err", "MetaMask was not found in this browser.");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      await refreshWallet(accounts[0]);
      log("info", `Connected ${roleLabel(state.account)} (${short(state.account)}) on ${networkLabel(state.chainId)}`);
    } catch (error) {
      log("err", `Connection failed: ${describeError(error)}`);
    }
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
    await refreshWallet(state.account);
  }

  async function ensureSigner(chainName) {
    if (!state.signer) throw new Error("Connect MetaMask first.");
    const cfg = state.config.chains[chainName];
    if (state.chainId !== cfg.chainId) {
      log("info", `Switching MetaMask to ${cfg.label}...`);
      await switchNetwork(chainName);
    }
    if (state.chainId !== cfg.chainId) {
      throw new Error(`MetaMask is on ${networkLabel(state.chainId)}; switch it to ${cfg.label} and try again.`);
    }
    return state.signer;
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

  async function readLeg(leg) {
    const chainName = LEGS[leg];
    const cfg = legChain(leg);
    const swapId = legSwapId(leg);
    if (!cfg || !cfg.htlc || !swapId) {
      state.observed[leg] = null;
      return;
    }
    try {
      const provider = state.read[chainName];
      const block = await provider.getBlock("latest");
      const contract = new ethers.Contract(cfg.htlc, state.config.abi[cfg.contract], provider);
      const swap = core.decodeSwap(await contract.getSwap(swapId));
      state.observed[leg] = {
        chainName,
        blockNumber: block.number,
        blockTimestamp: block.timestamp,
        observedAt: Date.now(),
        swap,
        labels: core.classify(swap, block.timestamp),
        balances: await readBalances(chainName),
        allowance: leg === "mst" ? await readAllowance() : null,
      };
    } catch (error) {
      state.observed[leg] = { chainName, error: describeError(error) };
    }
    render();
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

  async function readAllowance() {
    const cfg = state.config.chains.sepolia;
    const roles = state.config.roles;
    if (!cfg.mst || !roles.alice) return null;
    const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, state.read.sepolia);
    return token.allowance(roles.alice, cfg.htlc);
  }

  async function refresh() {
    if (!state.swap) return;
    await Promise.allSettled([readLeg("mst"), readLeg("eth")]);
    render();
  }

  // ---------------------------------------------------------- write side

  async function run(label, action) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      log("err", `${label}: ${describeError(error)}`);
    } finally {
      state.busy = false;
      render();
      await refresh();
    }
  }

  function assertRole(role, what) {
    if (roleFor(state.account) !== role) {
      throw new Error(`${what} must be signed by ${capitalise(role)}. Switch the MetaMask account.`);
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
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const amount = parseMst(state.swap.mstAmount);
      const token = new ethers.Contract(cfg.mst, state.config.abi.ERC20, signer);
      log("info", `Approving ${state.swap.mstAmount} MST for the escrow...`);
      const tx = await token.approve(cfg.htlc, amount);
      await tx.wait(1);
      log("ok", `Approved ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
    });
  }

  async function lockMst() {
    return run("Lock MST", async () => {
      assertRole("alice", "Locking the MST");
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const block = await state.read.sepolia.getBlock("latest");
      const deadline = block.timestamp + Number(state.swap.timelockSeconds) + Number(state.swap.marginSeconds);
      const amount = parseMst(state.swap.mstAmount);
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);

      log("info", `Locking ${state.swap.mstAmount} MST for Bob until ${core.formatTimestamp(deadline)}...`);
      const tx = await htlc.lock(state.swap.mstSwapId, cfg.mst, state.config.roles.bob, amount, state.swap.hashlock, deadline);
      await tx.wait(1);
      state.swap.mstDeadline = deadline;
      saveSwap();
      log("ok", `Locked ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
      await verifyLock("mst", {
        sender: state.account,
        recipient: state.config.roles.bob,
        token: cfg.mst,
        amount,
        hashlock: state.swap.hashlock,
        timelock: deadline,
      });
    });
  }

  async function lockEth() {
    return run("Lock ETH", async () => {
      assertRole("bob", "Locking the ETH");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const block = await state.read.arbitrum.getBlock("latest");
      const deadline = block.timestamp + Number(state.swap.timelockSeconds);
      const value = parseEth(state.swap.ethAmount);
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);

      log("info", `Locking ${state.swap.ethAmount} ETH for Alice until ${core.formatTimestamp(deadline)}...`);
      const tx = await htlc.lock(state.swap.ethSwapId, state.config.roles.alice, state.swap.hashlock, deadline, { value });
      await tx.wait(1);
      state.swap.ethDeadline = deadline;
      saveSwap();
      log("ok", `Locked ${state.swap.ethAmount} ETH`, { chain: "arbitrum", hash: tx.hash, leg: "eth" });
      await verifyLock("eth", {
        sender: state.account,
        recipient: state.config.roles.alice,
        token: ethers.ZeroAddress,
        amount: value,
        hashlock: state.swap.hashlock,
        timelock: deadline,
      });
    });
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

  async function claimEth() {
    return run("Claim ETH", async () => {
      assertRole("alice", "Claiming the ETH");
      assertClaimable("eth");
      if (!state.swap.preimage) throw new Error("No preimage available.");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);

      log("info", "Claiming the ETH with the preimage...");
      const tx = await htlc.claim(state.swap.ethSwapId, state.swap.preimage);
      const receipt = await tx.wait(1);
      const revealed = findClaimedPreimage(htlc, receipt) || state.swap.preimage;
      state.swap.revealedPreimage = revealed;
      saveSwap();
      log("ok", `Claimed the ETH. Preimage is now public: ${short(revealed)}`, { chain: "arbitrum", hash: tx.hash, leg: "eth" });
    });
  }

  async function claimMst() {
    return run("Claim MST", async () => {
      assertRole("bob", "Claiming the MST");
      assertClaimable("mst");
      const preimage = state.swap.revealedPreimage || state.swap.preimage;
      if (!preimage) throw new Error("No preimage available yet. Alice must claim the ETH first.");
      if (!core.equalBytes32(core.hashlockFor(preimage), state.swap.hashlock)) {
        throw new Error("That preimage does not match this swap's hashlock.");
      }
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);

      log("info", "Claiming the MST with the revealed preimage...");
      const tx = await htlc.claim(state.swap.mstSwapId, preimage);
      await tx.wait(1);
      log("ok", `Claimed ${state.swap.mstAmount} MST`, { chain: "sepolia", hash: tx.hash, leg: "mst" });
    });
  }

  async function refundMst() {
    return run("Refund MST", async () => {
      assertRole("alice", "Refunding the MST");
      assertRefundable("mst");
      const cfg = state.config.chains.sepolia;
      const signer = await ensureSigner("sepolia");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ERC20HTLC, signer);
      log("info", "Refunding the expired MST lock...");
      const tx = await htlc.refund(state.swap.mstSwapId);
      await tx.wait(1);
      log("ok", "Refunded the MST to Alice", { chain: "sepolia", hash: tx.hash, leg: "mst" });
    });
  }

  async function refundEth() {
    return run("Refund ETH", async () => {
      assertRole("bob", "Refunding the ETH");
      assertRefundable("eth");
      const cfg = state.config.chains.arbitrum;
      const signer = await ensureSigner("arbitrum");
      const htlc = new ethers.Contract(cfg.htlc, state.config.abi.ETHHTLC, signer);
      log("info", "Refunding the expired ETH lock...");
      const tx = await htlc.refund(state.swap.ethSwapId);
      await tx.wait(1);
      log("ok", "Refunded the ETH to Bob", { chain: "arbitrum", hash: tx.hash, leg: "eth" });
    });
  }

  // ------------------------------------------------------------- render

  function chainHasSwap() {
    return ["mst", "eth"].some((leg) => {
      const observation = state.observed[leg];
      return observation && observation.swap && observation.swap.state !== "None";
    });
  }

  function render() {
    if (!state.config) return;
    renderWallet();
    renderSecret();
    renderLeg("mst");
    renderLeg("eth");
    $("next-action").textContent = nextActionHint();
    $("connect").disabled = !window.ethereum || Boolean(state.account);
    $("refresh").disabled = state.busy;

    const locked = Boolean(chainHasSwap());
    for (const id of ["mst-amount", "eth-amount", "timelock", "margin"]) $(id).disabled = locked;
    $("generate").disabled = state.busy || locked;
    $("generate").title = locked ? "This swap already exists on-chain; press Reset to start a new one" : "";
  }

  function renderWallet() {
    const wallet = $("wallet-status");
    const network = $("network-status");
    if (state.account) {
      wallet.textContent = `${roleLabel(state.account)} · ${short(state.account)}`;
      wallet.className = "pill good";
    } else {
      wallet.textContent = "not connected";
      wallet.className = "pill muted";
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

  function renderLeg(leg) {
    const cfg = legChain(leg);
    const observation = state.observed[leg];
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

    const balances = observation && observation.balances;
    if (observation && observation.error) {
      $(`${leg}-balances`).textContent = `Read error: ${observation.error}`;
    } else if (balances) {
      $(`${leg}-balances`).textContent = leg === "mst"
        ? `Alice: ${ethers.formatEther(balances.alice.eth)} ETH · ${ethers.formatUnits(balances.alice.mst, state.decimals)} MST\nBob:   ${ethers.formatEther(balances.bob.eth)} ETH · ${ethers.formatUnits(balances.bob.mst, state.decimals)} MST`
        : `Alice: ${ethers.formatEther(balances.alice.eth)} ETH\nBob:   ${ethers.formatEther(balances.bob.eth)} ETH`;
    } else {
      $(`${leg}-balances`).textContent = "";
    }

    const me = roleFor(state.account);
    const labels = observation && observation.labels;
    const exists = Boolean(observation && observation.swap && observation.swap.state !== "None");
    // Remember that this page already locked, even if a read fails later.
    const lockedHere = leg === "mst" ? Boolean(swap.mstDeadline) : Boolean(swap.ethDeadline);
    const canClaim = Boolean(labels && labels.claimable)
      && (leg === "mst" ? me === "bob" : me === "alice")
      && Boolean(state.swap.revealedPreimage || state.swap.preimage);
    const canRefund = Boolean(labels && labels.refundable) && (leg === "mst" ? me === "alice" : me === "bob");
    const canLock = !exists && !lockedHere && (leg === "mst" ? me === "alice" : me === "bob");
    const allowanceShort = Boolean(
      leg === "mst" && observation && observation.allowance !== null && observation.allowance < parseMst(state.swap.mstAmount)
    );

    if (leg === "mst") {
      setButton("approve-mst", !state.busy && canLock && allowanceShort, !me
        ? "Connect a wallet"
        : me !== "alice" ? "Only Alice can approve the MST"
          : !allowanceShort ? "The allowance is already sufficient" : "Approve the escrow to pull the MST");
      setButton("lock-mst", !state.busy && canLock, me !== "alice" ? "Only Alice can lock the MST" : "Lock the MST for Bob");
      setButton("claim-mst", !state.busy && canClaim, me !== "bob" ? "Only Bob can claim the MST" : !canClaim ? "Not claimable now (expired, completed, or no preimage)" : "Claim the MST with the revealed preimage");
      setButton("refund-mst", !state.busy && canRefund, me !== "alice" ? "Only Alice can refund the MST" : !canRefund ? "Refund is only valid after Alice's deadline" : "Refund the expired MST lock");
    } else {
      setButton("lock-eth", !state.busy && canLock, me !== "bob" ? "Only Bob can lock the ETH" : "Lock the ETH for Alice");
      setButton("claim-eth", !state.busy && canClaim, me !== "alice" ? "Only Alice can claim the ETH" : !canClaim ? "Not claimable now (expired, completed, or no preimage)" : "Claim the ETH, revealing the preimage");
      setButton("refund-eth", !state.busy && canRefund, me !== "bob" ? "Only Bob can refund the ETH" : !canRefund ? "Refund is only valid after Bob's deadline" : "Refund the expired ETH lock");
    }

    const hash = state.lastTx[leg];
    if (observation && observation.swap && observation.swap.state === "Claimed") {
      $(`${leg}-tx`).innerHTML = hash ? `claimed · ${txLink(leg, hash)}` : "claimed";
    } else if (observation && observation.swap && observation.swap.state === "Refunded") {
      $(`${leg}-tx`).innerHTML = hash ? `refunded · ${txLink(leg, hash)}` : "refunded";
    } else if (observation && observation.blockNumber) {
      $(`${leg}-tx`).textContent = `observed at block ${observation.blockNumber}`;
    } else {
      $(`${leg}-tx`).textContent = "";
    }
  }

  function renderDeadline(leg) {
    const observation = state.observed[leg];
    const node = $(`${leg}-leg-deadline`);
    if (observation && observation.error) {
      node.textContent = "—";
      return;
    }
    if (observation && observation.swap && observation.swap.state !== "None") {
      node.textContent = deadlineText(observation);
      return;
    }
    const planned = leg === "mst" ? state.swap.mstDeadline : state.swap.ethDeadline;
    node.textContent = planned ? `planned ${core.formatTimestamp(planned)}` : "set when the lock is created";
  }

  function deadlineText(observation) {
    const elapsed = (Date.now() - observation.observedAt) / 1000;
    const now = observation.blockTimestamp + elapsed;
    const left = observation.swap.timelock - now;
    const base = core.formatTimestamp(observation.swap.timelock);
    return left > 0
      ? `${base} · in ${core.formatDuration(left)}`
      : `${base} · expired ${core.formatDuration(-left)} ago`;
  }

  function renderCountdowns() {
    for (const leg of Object.keys(LEGS)) {
      const observation = state.observed[leg];
      if (!observation || observation.error || !observation.swap || observation.swap.state === "None") continue;
      $(`${leg}-leg-deadline`).textContent = deadlineText(observation);
    }
  }

  function setButton(id, enabled, title) {
    const button = $(id);
    button.disabled = Boolean(!enabled);
    button.title = title || "";
  }

  function nextActionHint() {
    if (!state.config) return "Loading configuration...";
    if (!state.account) return "Connect MetaMask. Alice holds the MST; Bob holds the ETH.";
    if (!state.swap || !state.swap.preimage) return "Click “Generate new secret” to create the preimage, hashlock and both swap ids.";
    if (!state.config.chains.sepolia.htlc || !state.config.chains.arbitrum.htlc) {
      return "Deploy both escrows first (npm run deploy), then restart the UI.";
    }
    const mst = state.observed.mst;
    const eth = state.observed.eth;
    if (!mst || !eth) return "Reading both chains...";
    if (mst.error || eth.error) return `Cannot read a chain: ${mst.error || eth.error}`;
    if (mst.swap.state === "None" && eth.swap.state === "None") {
      return `Alice: approve ${state.swap.mstAmount} MST, then lock it on Sepolia (current account: ${roleLabel(state.account)}).`;
    }
    if (mst.labels.claimable && eth.swap.state === "None") {
      return "Bob: verify Alice's lock, switch MetaMask to Bob, then lock the ETH on Arbitrum.";
    }
    if (eth.labels.claimable && mst.swap.state === "Active") {
      return "Alice: claim the ETH. That publishes the preimage so Bob can claim the MST.";
    }
    if (eth.swap.state === "Claimed" && mst.labels.claimable) {
      return "Bob: claim the MST with the preimage revealed by Alice's ETH claim.";
    }
    if (mst.swap.state === "Claimed" && eth.swap.state === "Claimed") {
      return "Swap complete: both legs are claimed. Press Reset to run another swap.";
    }
    if (mst.labels.refundable || eth.labels.refundable) {
      const legs = [mst.labels.refundable ? "MST (Alice)" : null, eth.labels.refundable ? "ETH (Bob)" : null].filter(Boolean);
      return `Timelock expired: ${legs.join(" and ")} can be refunded by its sender.`;
    }
    if (mst.swap.state === "Refunded" || eth.swap.state === "Refunded") {
      return "This swap was (partly) refunded. Reset to run another swap.";
    }
    return "Waiting for the next step.";
  }

  // -------------------------------------------------------------- events

  function wireEvents() {
    $("connect").addEventListener("click", connect);
    $("switch-sepolia").addEventListener("click", () => guard("Switch network", () => switchNetwork("sepolia")));
    $("switch-arbitrum").addEventListener("click", () => guard("Switch network", () => switchNetwork("arbitrum")));
    $("generate").addEventListener("click", generateSwap);
    $("reset").addEventListener("click", resetSwap);
    $("refresh").addEventListener("click", () => refresh());
    $("reveal").addEventListener("click", () => {
      state.revealPreimage = !state.revealPreimage;
      render();
    });

    $("approve-mst").addEventListener("click", approveMst);
    $("lock-mst").addEventListener("click", lockMst);
    $("claim-mst").addEventListener("click", claimMst);
    $("refund-mst").addEventListener("click", refundMst);
    $("lock-eth").addEventListener("click", lockEth);
    $("claim-eth").addEventListener("click", claimEth);
    $("refund-eth").addEventListener("click", refundEth);

    for (const id of ["mst-amount", "eth-amount", "timelock", "margin"]) {
      $(id).addEventListener("change", syncInputsToSwap);
    }

    if (window.ethereum) {
      window.ethereum.on("accountsChanged", (accounts) => {
        if (accounts && accounts[0]) {
          refreshWallet(accounts[0]).catch((error) => log("err", `Wallet refresh failed: ${describeError(error)}`));
        } else {
          state.account = null;
          state.signer = null;
          render();
        }
      });
      window.ethereum.on("chainChanged", () => {
        refreshWallet(state.account).catch((error) => log("err", `Wallet refresh failed: ${describeError(error)}`));
      });
    }
  }

  function guard(label, action) {
    Promise.resolve()
      .then(action)
      .catch((error) => log("err", `${label}: ${describeError(error)}`));
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
      };
      state.revealPreimage = false;
      state.observed = {};
      state.lastTx = {};
      saveSwap();
      applySwapToInputs();
      render();
      refresh();
      log("info", `New swap ready. Hashlock ${short(state.swap.hashlock)}`);
    } catch (error) {
      log("err", error.message);
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
