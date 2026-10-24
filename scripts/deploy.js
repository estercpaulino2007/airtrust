// Deploys AirTrustLedger to the selected Hardhat network (e.g. `npm run deploy:amoy`).
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying AirTrustLedger to ${network.name} from ${deployer.address}…`);
  const ledger = await (await ethers.getContractFactory("AirTrustLedger")).deploy();
  await ledger.waitForDeployment();
  console.log(`AirTrustLedger deployed at ${await ledger.getAddress()}`);
  console.log("Set CONTRACT_ADDRESS, RPC_URL and LEDGER_PRIVATE_KEY in .env to use it.");
}

main().catch((e) => { console.error(e); process.exit(1); });
