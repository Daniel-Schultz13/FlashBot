const { BigNumber, Contract, Wallet, providers, utils, getDefaultProvider } = require("ethers");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");

const PRIVATE_KEY = process.env.PRIVATE_KEY || ""
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "0x35ad48E5c15d5c2786CdE9b56C6483C85C4dd34D"
const CHAIN_ID = 1;
const GWEI = BigNumber.from(10).pow(9)
const PRIORITY_FEE = GWEI.mul(3)
const BLOCKS_IN_THE_FUTURE = 2;
const LEGACY_GAS_PRICE = GWEI.mul(12)
// enum FlashbotsBundleResolution {
//     BundleIncluded,
//     BlockPassedWithoutInclusion,
//     AccountNonceTooHigh
// }
if (PRIVATE_KEY === "") {
    console.warn("Must provide PRIVATE_KEY environment variable")
    process.exit(1)
}

const BUNDLE_EXECUTOR_ABI = [
    {
        "inputs": [],
        "name": "deposit",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "token1",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "token2",
                "type": "address"
            },
            {
                "internalType": "uint256",
                "name": "borrow_amount",
                "type": "uint256"
            },
            {
                "internalType": "address",
                "name": "router1",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "router2",
                "type": "address"
            }
        ],
        "name": "flashloan",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "logic1",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "stateMutability": "nonpayable",
        "type": "constructor"
    }
]

const ETHER = BigNumber.from(10).pow(18);

function bigNumberToDecimal(value, base = 18) {
    const divisor = BigNumber.from(10).pow(base)
    return value.mul(10000).div(divisor).toNumber() / 10000
}

function getDefaultRelaySigningKey() {
    // console.warn("You have not specified an explicity FLASHBOTS_RELAY_SIGNING_KEY environment variable. Creating random signing key, this searcher will not be building a reputation for next run")
    return Wallet.createRandom().privateKey;
}

// const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
// const provider = new providers.JsonRpcProvider(ETHEREUM_RPC_URL);
const provider = getDefaultProvider(CHAIN_ID);
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();
// const FLASHBOTS_RELAY_SIGNING_KEY = ""
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);
const DEFAULT_FLASHBOTS_RELAY = 'https://relay.flashbots.net'
const FLASHBOTS_EP = 'https://relay-goerli.flashbots.net/'

function healthcheck() {
    if (HEALTHCHECK_URL === "") {
        return
    }
    get(HEALTHCHECK_URL).on('error', console.error);
}

function getMaxBaseFeeInFutureBlock(baseFee, blocksInFuture) {
    let maxBaseFee = BigNumber.from(baseFee)
    for (let i = 0; i < blocksInFuture; i++) {
        maxBaseFee = maxBaseFee.mul(1125).div(1000).add(1)
    }
    return maxBaseFee
}

async function main() {
    console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress())
    console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress())

    const bundleExecutorContract = new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider)
    // console.log(bundleExecutorContract);
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet, DEFAULT_FLASHBOTS_RELAY)
    console.log("FlashbotsBundleProvide ready!")
    const tokenAddress1 = "0x92B30dF9b169FAC44c86983B2aAAa465FDC2CDB8"
    const tokenAddress2 = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984"
    const borrow_amount = BigNumber.from("10000000000000000000")
    const dexRouter1 = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    const dexRouter2 = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"
    const ethAmountToCoinbase = BigNumber.from("10000000000000000")
    const nonce = await provider.getTransactionCount(arbitrageSigningWallet.address);

    const transaction = await bundleExecutorContract.populateTransaction.flashloan(tokenAddress1, tokenAddress2, borrow_amount, dexRouter1, dexRouter2, {
        gasPrice: LEGACY_GAS_PRICE,
        gasLimit: BigNumber.from(1000000),
    });
    try {
        const estimateGas = await bundleExecutorContract.provider.estimateGas(
            {
                ...transaction,
                from: arbitrageSigningWallet.address
            })
        if (estimateGas.gt(1400000)) {
            console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
        }
        transaction.gasLimit = estimateGas.mul(2)
    } catch (e) {
        console.warn(`Estimate gas failure ${e}`)
        return;
    }
    // transaction.nonce = nonce
    try {
        provider.on('block', async (blockNumber) => {
            console.log("============= blockNumber is " + blockNumber + " =============");
            const block = await provider.getBlock(blockNumber)
            const maxBaseFeeInFutureBlock = getMaxBaseFeeInFutureBlock(block.baseFeePerGas, BLOCKS_IN_THE_FUTURE)
            // console.log(maxBaseFeeInFutureBlock);

            const eip1559Transaction = {
                to: transaction.to,
                type: 2,
                maxFeePerGas: PRIORITY_FEE.add(maxBaseFeeInFutureBlock),
                maxPriorityFeePerGas: PRIORITY_FEE,
                gasLimit: transaction.gasLimit,
                data: transaction.data,
                chainId: CHAIN_ID
            }
            const bundledTransactions = [
                {
                    signer: arbitrageSigningWallet,
                    transaction: eip1559Transaction
                }
            ];
            // console.log(bundledTransactions)
            const signedBundle = await flashbotsProvider.signBundle(bundledTransactions)
            const simulation = await flashbotsProvider.simulate(signedBundle, blockNumber + 1)
            if ("error" in simulation || simulation.firstRevert !== undefined) {
                console.log(simulation)
                return;
            }
            console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
            const bundleSubmission = await flashbotsProvider.sendRawBundle(
                signedBundle,
                blockNumber + 1
            )
            // const bundleSubmission2 = await flashbotsProvider.sendRawBundle(
            //     signedBundle,
            //     blockNumber + 2
            // )
            console.log('bundle submitted, waiting')
            if ('error' in bundleSubmission) {
                throw new Error(bundleSubmission.error.message)
            }
            const waitResponse = await bundleSubmission.wait()
            console.log(`Wait Response: ${waitResponse}`)
            if (waitResponse === 0 || waitResponse === 3) {
                console.log("successfully done!!!");
                process.exit(0)
            } else {
                console.log({
                    bundleStats: await flashbotsProvider.getBundleStats(simulation.bundleHash, blockNumber + 1),
                    userStats: await flashbotsProvider.getUserStats()
                })
            }
        })
    } catch (e) {
        console.log(e);
    }

}

main();