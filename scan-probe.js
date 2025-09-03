import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------- Helpers ----------------------

const nowIso = () => new Date().toISOString();

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function appendCsvRow(csvPath, headers, row) {
  const exists = fs.existsSync(csvPath);
  const line = headers.map(h => row[h]).join(",") + "\n";
  if (!exists) {
    fs.appendFileSync(csvPath, headers.join(",") + "\n");
  }
  fs.appendFileSync(csvPath, line);
}

function bnToFloatStr(bn, decimals, maxDp = 8) {
  if (bn == null) return "0";
  const s = ethers.formatUnits(bn, decimals);
  const [int, frac = ""] = s.split(".");
  if (maxDp === 0) return int;
  return frac.length > maxDp ? `${int}.${frac.slice(0, maxDp)}` : s;
}

function safePctBps(pnl, input) {
  if (input === 0n) return 0;
  return Number((pnl * 10000n) / input);
}

// ---------------------- ABIs ----------------------

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
];

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)",
  "function quoteExactInput(bytes path, uint256 amountIn) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInputSingle((address,address,uint24,uint256,uint160)) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

const WOMBAT_POOL_ABI = [
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) external view returns (uint256 potentialOutcome, uint256 haircut)"
];

// ---------------------- Core functions ----------------------

async function quoteV2({ router, path, amountIn }) {
  try {
    const amounts = await router.getAmountsOut(amountIn, path, { blockTag: "pending" });
    return amounts[amounts.length - 1];
  } catch (e) {
    throw new Error(`V2 quote failed: ${e.reason || e.message}`);
  }
}

async function quoteV3Single({ quoter, tokenIn, tokenOut, fee, amountIn }) {
  try {
    const out = await quoter.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      fee,
      amountIn,
      0, // no price limit
      { blockTag: "pending" }
    );

    if (typeof out === "bigint") return out;
    if (Array.isArray(out)) return out[0];
    if (out?.amountOut != null) return out.amountOut;
    return out;
  } catch (e1) {
    try {
      const pathBytes =
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
      const packed = ethers.concat([
        tokenIn,
        ethers.toBeHex(fee, 3), // 3 bytes fee
        tokenOut
      ]);
      const out2 = await quoter.quoteExactInput(packed, amountIn, { blockTag: "pending" });
      if (typeof out2 === "bigint") return out2;
      if (Array.isArray(out2)) return out2[0];
      if (out2?.amountOut != null) return out2.amountOut;
      return out2;
    } catch (e2) {
      throw new Error(`V3 quote failed: ${e2.reason || e2.message} (fallback after: ${e1.reason || e1.message})`);
    }
  }
}

async function quoteWombat({ pool, from, to, amountIn }) {
  try {
    const [amountOut] = await pool.quotePotentialSwap(from, to, amountIn, { blockTag: "pending" });
    return amountOut;
  } catch (e) {
    throw new Error(`Wombat quote failed: ${e.reason || e.message}`);
  }
}

// ---------------------- Route evaluators ----------------------

/**
 * Cross-version (2-hop): WBNB -> USDT (leg1) -> WBNB (leg2)
 * Direction A: leg1 on V2, leg2 on V3
 * Direction B: leg1 on V3, leg2 on V2
 */
async function evalCrossVersion({ sizeInWBNB, cfg, ctx, dir }) {
  const { tokens, v2, v3 } = ctx;
  const WBNB = tokens.WBNB.addr, USDT = tokens.USDT.addr;

  try {
    let midOut, finalOut;
    if (dir === "V2->V3") {
      // leg1 V2: WBNB -> USDT
      midOut = await quoteV2({ router: v2.router, path: [WBNB, USDT], amountIn: sizeInWBNB });
      // leg2 V3: USDT -> WBNB
      finalOut = await quoteV3Single({ quoter: v3.quoter, tokenIn: USDT, tokenOut: WBNB, fee: cfg.v3FeeTiers["USDT/WBNB"], amountIn: midOut });
    } else {
      // leg1 V3: WBNB -> USDT
      midOut = await quoteV3Single({ quoter: v3.quoter, tokenIn: WBNB, tokenOut: USDT, fee: cfg.v3FeeTiers["WBNB/USDT"], amountIn: sizeInWBNB });
      // leg2 V2: USDT -> WBNB
      finalOut = await quoteV2({ router: v2.router, path: [USDT, WBNB], amountIn: midOut });
    }
    const legs = `${dir}:${ctx.syms.WBNB}->${ctx.syms.USDT}->${ctx.syms.WBNB}`;
    return { ok: true, routeType: dir === "V2->V3" ? "V2→V3" : "V3→V2", legs, in: sizeInWBNB, out: finalOut };
  } catch (e) {
    return { ok: false, error: e.message, routeType: dir === "V2->V3" ? "V2→V3" : "V3→V2" };
  }
}

/**
 * Triangular (single DEX, Pancake V2): WBNB -> USDT -> BUSD -> WBNB
 */
async function evalTriangleV2({ sizeInWBNB, ctx }) {
  const { tokens, v2, syms } = ctx;
  const path = [tokens.WBNB.addr, tokens.USDT.addr, tokens.BUSD.addr, tokens.WBNB.addr];
  try {
    const out = await quoteV2({ router: v2.router, path, amountIn: sizeInWBNB });
    const legs = `TRI_V2:${syms.WBNB}->${syms.USDT}->${syms.BUSD}->${syms.WBNB}`;
    return { ok: true, routeType: "TRI", legs, in: sizeInWBNB, out };
  } catch (e) {
    return { ok: false, error: e.message, routeType: "TRI" };
  }
}

/**
 * Triangular with Wombat as stable hop:
 *  A) WBNB -> USDT (V2) -> USDC (Wombat) -> WBNB (V2)
 *  B) WBNB -> USDC (V2) -> USDT (Wombat) -> WBNB (V2)
 */
async function evalTriangleWombat({ sizeInWBNB, ctx, variant }) {
  const { tokens, v2, wombat, syms, cfg } = ctx;
  try {
    let leg1Out, leg2Out, finalOut, legs, label;

    if (variant === "A") {
      // V2: WBNB -> USDT
      leg1Out = await quoteV2({ router: v2.router, path: [tokens.WBNB.addr, tokens.USDT.addr], amountIn: sizeInWBNB });
      // Wombat: USDT -> USDC
      leg2Out = await quoteWombat({ pool: wombat.pool, from: tokens.USDT.addr, to: tokens.USDC.addr, amountIn: leg1Out });
      // V2: USDC -> WBNB
      finalOut = await quoteV2({ router: v2.router, path: [tokens.USDC.addr, tokens.WBNB.addr], amountIn: leg2Out });
      legs = `TRI_WOMBAT_A:${syms.WBNB}->${syms.USDT} (V2)->${syms.USDC} (Wombat)->${syms.WBNB} (V2)`;
      label = "TRI_WOMBAT_A";
    } else {
      // V2: WBNB -> USDC
      leg1Out = await quoteV2({ router: v2.router, path: [tokens.WBNB.addr, tokens.USDC.addr], amountIn: sizeInWBNB });
      // Wombat: USDC -> USDT
      leg2Out = await quoteWombat({ pool: wombat.pool, from: tokens.USDC.addr, to: tokens.USDT.addr, amountIn: leg1Out });
      // V2: USDT -> WBNB
      finalOut = await quoteV2({ router: v2.router, path: [tokens.USDT.addr, tokens.WBNB.addr], amountIn: leg2Out });
      legs = `TRI_WOMBAT_B:${syms.WBNB}->${syms.USDC} (V2)->${syms.USDT} (Wombat)->${syms.WBNB} (V2)`;
      label = "TRI_WOMBAT_B";
    }

    return { ok: true, routeType: label, legs, in: sizeInWBNB, out: finalOut };
  } catch (e) {
    return { ok: false, error: e.message, routeType: variant === "A" ? "TRI_WOMBAT_A" : "TRI_WOMBAT_B" };
  }
}

// ---------------------- Gas & fees ----------------------

function estimateGasUnitsForRoute(routeType, cfg) {
  // rough static estimates
  switch (routeType) {
    case "V2→V3":
    case "V3→V2":
      return cfg.gasEstimates.v2Swap + cfg.gasEstimates.v3Swap; 
    case "TRI":
      return cfg.gasEstimates.v2Swap * 3; 
    case "TRI_WOMBAT_A":
    case "TRI_WOMBAT_B":
      return cfg.gasEstimates.v2Swap * 2 + cfg.gasEstimates.wombatSwap; 
    default:
      return cfg.gasEstimates.v2Swap * 2;
  }
}

function flashloanFeeInWBNB(amountInWBNB, cfg) {
  return (amountInWBNB * BigInt(cfg.flashloanFeeBps)) / 10000n;
}

function gasCostInWBNB(gasPriceWei, gasUnits) {
  return gasPriceWei * BigInt(gasUnits);
}

// ---------------------- Main function ----------------------

async function main() {
  // CLI args
  const args = process.argv.slice(2);
  const configPathIdx = args.findIndex(a => a === "--config");
  const configPath = configPathIdx >= 0 ? args[configPathIdx + 1] : path.join(__dirname, "probe.config.json");

  const cfg = loadJson(configPath);

  // Provider
  const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP ?? cfg.rpcUrl);
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? ethers.parseUnits(cfg.defaultGasPriceGwei ?? "3", "gwei");

  // Contracts
  const v2Router = new ethers.Contract(cfg.addresses.pancakeV2Router, V2_ROUTER_ABI, provider);
  const v3Quoter = new ethers.Contract(cfg.addresses.pancakeV3QuoterV2, V3_QUOTER_ABI, provider);
  const wombatPool = new ethers.Contract(cfg.addresses.wombatPool, WOMBAT_POOL_ABI, provider);

  // Token details
  const tokens = {
    WBNB: { addr: cfg.tokens.WBNB.address, dec: cfg.tokens.WBNB.decimals },
    USDT: { addr: cfg.tokens.USDT.address, dec: cfg.tokens.USDT.decimals },
    USDC: { addr: cfg.tokens.USDC.address, dec: cfg.tokens.USDC.decimals },
    BUSD: { addr: cfg.tokens.BUSD.address, dec: cfg.tokens.BUSD.decimals }
  };
  const syms = { WBNB: "WBNB", USDT: "USDT", USDC: "USDC", BUSD: "BUSD" };

  const ctx = {
    cfg,
    provider,
    syms,
    tokens,
    v2: { router: v2Router },
    v3: { quoter: v3Quoter },
    wombat: { pool: wombatPool }
  };

  // CSV
  const csvPath = path.join(__dirname, "probe_ops.csv");
  const CSV_HEADERS = ["timestamp", "routeType", "size", "legs", "in", "out", "pnl", "bps", "gasCostWBNB", "flashFeeWBNB", "netPnl", "note"];

  const sizesWBNB = cfg.sizesWBNB?.length ? cfg.sizesWBNB : ["0.01", "0.02", "0.05", "0.1"];
  const pollMs = cfg.pollIntervalMs ?? 5000;

  console.log(`\n[${nowIso()}] Probe starting…`);
  console.log(`RPC: ${provider?.connection?.url || "custom"} | GasPrice: ${ethers.formatUnits(gasPriceWei, 9)} gwei`);
  console.log(`Sizes: ${sizesWBNB.join(", ")} WBNB | Poll: ${pollMs} ms\n`);

  // Continuous loop
  while (true) {
    const batchResults = [];

    for (const sz of sizesWBNB) {
      const sizeIn = ethers.parseUnits(sz, tokens.WBNB.dec);

      // 1) Cross-version both directions
      for (const dir of ["V2->V3", "V3->V2"]) {
        const r = await evalCrossVersion({ sizeInWBNB: sizeIn, cfg, ctx, dir });
        if (r.ok) {
          const gasUnits = estimateGasUnitsForRoute(r.routeType, cfg);
          const gasWei = gasCostInWBNB(gasPriceWei, gasUnits);
          const gasWBNB = gasWei; // 1 wei BNB == 1 wei WBNB

          const flashFee = flashloanFeeInWBNB(sizeIn, cfg);
          const pnl = r.out - r.in; // raw before costs
          const net = pnl - gasWBNB - flashFee;
          const bps = safePctBps(pnl, r.in);

          batchResults.push({
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in,
            out: r.out,
            pnl,
            bps,
            gasWBNB,
            flashFee,
            netPnl: net,
            note: ""
          });

          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in.toString(),
            out: r.out.toString(),
            pnl: pnl.toString(),
            bps: bps.toString(),
            gasCostWBNB: gasWBNB.toString(),
            flashFeeWBNB: flashFee.toString(),
            netPnl: net.toString(),
            note: ""
          });
        } else {
          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: "",
            in: "0",
            out: "0",
            pnl: "0",
            bps: "0",
            gasCostWBNB: "0",
            flashFeeWBNB: "0",
            netPnl: "0",
            note: `ERR 1one:${r.error?.replaceAll(",", ";")?.slice(0, 160)}`
          });
        }
      }

      // 2) Triangular on Pancake V2
      {
        const r = await evalTriangleV2({ sizeInWBNB: sizeIn, ctx });
        if (r.ok) {
          const gasUnits = estimateGasUnitsForRoute(r.routeType, cfg);
          const gasWBNB = gasCostInWBNB(gasPriceWei, gasUnits);
          const flashFee = flashloanFeeInWBNB(sizeIn, cfg);
          const pnl = r.out - r.in;
          const net = pnl - gasWBNB - flashFee;
          const bps = safePctBps(pnl, r.in);

          batchResults.push({
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in,
            out: r.out,
            pnl,
            bps,
            gasWBNB,
            flashFee,
            netPnl: net,
            note: ""
          });

          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in.toString(),
            out: r.out.toString(),
            pnl: pnl.toString(),
            bps: bps.toString(),
            gasCostWBNB: gasWBNB.toString(),
            flashFeeWBNB: flashFee.toString(),
            netPnl: net.toString(),
            note: ""
          });
        } else {
          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: "",
            in: "0",
            out: "0",
            pnl: "0",
            bps: "0",
            gasCostWBNB: "0",
            flashFeeWBNB: "0",
            netPnl: "0",
            note: `ERR 2two:${r.error?.replaceAll(",", ";")?.slice(0, 160)}`
          });
        }
      }

      // 3) Triangular with Wombat middle hop (A and B)
      for (const variant of ["A", "B"]) {
        const r = await evalTriangleWombat({ sizeInWBNB: sizeIn, ctx, variant });
        if (r.ok) {
          const gasUnits = estimateGasUnitsForRoute(r.routeType, cfg);
          const gasWBNB = gasCostInWBNB(gasPriceWei, gasUnits);
          const flashFee = flashloanFeeInWBNB(sizeIn, cfg);
          const pnl = r.out - r.in;
          const net = pnl - gasWBNB - flashFee;
          const bps = safePctBps(pnl, r.in);

          batchResults.push({
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in,
            out: r.out,
            pnl,
            bps,
            gasWBNB,
            flashFee,
            netPnl: net,
            note: ""
          });

          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: r.legs,
            in: r.in.toString(),
            out: r.out.toString(),
            pnl: pnl.toString(),
            bps: bps.toString(),
            gasCostWBNB: gasWBNB.toString(),
            flashFeeWBNB: flashFee.toString(),
            netPnl: net.toString(),
            note: ""
          });
        } else {
          appendCsvRow(csvPath, CSV_HEADERS, {
            timestamp: nowIso(),
            routeType: r.routeType,
            size: sz,
            legs: "",
            in: "0",
            out: "0",
            pnl: "0",
            bps: "0",
            gasCostWBNB: "0",
            flashFeeWBNB: "0",
            netPnl: "0",
            note: `ERR 3three:${r.error?.replaceAll(",", ";")?.slice(0, 160)}`
          });
        }
      }
    }

    // Rank by raw P&L
    const ranked = batchResults
      .filter(r => r && typeof r.pnl === "bigint")
      .sort((a, b) => (a.pnl > b.pnl ? -1 : a.pnl < b.pnl ? 1 : 0))
      .slice(0, 10);

    if (ranked.length) {
      console.log(`\n[${nowIso()}] Top 10 (by raw PnL):`);
      console.table(
        ranked.map(r => ({
          routeType: r.routeType,
          sizeWBNB: r.size,
          pnlWBNB: bnToFloatStr(r.pnl, 18, 8),
          bps: r.bps,
          gasWBNB: bnToFloatStr(r.gasWBNB, 18, 8),
          flashFeeWBNB: bnToFloatStr(r.flashFee, 18, 8),
          netPnlWBNB: bnToFloatStr(r.netPnl, 18, 8),
          legs: r.legs
        }))
      );
    } else {
      console.log(`[${nowIso()}] No successful quotes in this cycle.`);
    }

    await sleep(pollMs);
  }
}

main().catch(err => {
  console.error(`[FATAL ${nowIso()}]`, err);
  process.exit(1);
});
