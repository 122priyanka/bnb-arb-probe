# BNB Cross-Version & Triangular Arb Probe (Mini)

Detect **candidate arbitrage opportunities** by probing quotes (read-only) across:
1. **Cross-version drift** (Pancake V2 ↔ V3),
2. **Triangular loops** on a single DEX (Pancake V2),
3. **Stablecoin middle hop** via **Wombat** (USDT ↔ USDC).

> **No transactions are sent. Quotes only.**  
> Uses `ethers@6`, Node 18+. No external SDKs.

**How to Run** 
1. Clone the repository
git clone https://github.com/your-username/bnb-arb-probe.git
cd bnb-arb-probe

2. Install dependencies
npm install

3. Run the script
node scan-probe.js
