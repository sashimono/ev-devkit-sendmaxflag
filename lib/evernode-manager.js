const evernode = require("evernode-js-client")
const uuid = require('uuid');
const { info } = require("./logger");
const { generateAccount } = require("./common");
const appenv = require("../appenv");

const LEDGERS_PER_HOUR = 1190;
const XRPL_TIMESTAMP_OFFSET = 946684800;

class EvernodeManager {
    #xrplApi;

    #network;
    #xahaudServer;

    #tenantSecret;

    #registryClient;
    #tenantClient;

    constructor(options = {}) {
        this.#network = appenv.network;
        this.#xahaudServer = appenv.xahaudServer;
        this.#tenantSecret = options.tenantSecret;
    }

    async init() {
        await evernode.Defaults.useNetwork(this.#network);
        this.#xrplApi = new evernode.XrplApi(this.#xahaudServer);
        info(`Using - network: '${this.#network}'${this.#xahaudServer ? `, server: '${this.#xahaudServer}'` : ''}`);
        evernode.Defaults.set({
            xrplApi: this.#xrplApi,
            useCentralizedRegistry: true
        });
        await this.#xrplApi.connect();

        this.#registryClient = await evernode.HookClientFactory.create(evernode.HookTypes.registry);
        await this.#registryClient.connect();

        if (this.#tenantSecret) {
            this.#tenantClient = new evernode.TenantClient(null, this.#tenantSecret, { config: this.#registryClient.config });
            this.#tenantClient.xrplAcc.address = this.#tenantClient.xrplAcc.wallet.classicAddress;
            await this.#tenantClient.connect();
            await this.#tenantClient.prepareAccount();
        }

    }

    async terminate() {
        if (this.#tenantClient)
            await this.#tenantClient.disconnect();
        if (this.#registryClient)
            await this.#registryClient.disconnect();
        if (this.#xrplApi)
            await this.#xrplApi.disconnect();
    }

    async getActiveHosts(hostAddresses) {
        return (await Promise.all(hostAddresses.map(async h => {
            var host = null;
            try {
                host = await this.getHostInfo(h);
            }
            catch (e) { }
            return host;
        }))).filter(h => h?.active);
    }

    async getActiveHostsFromLedger() {
        return await this.#registryClient.getActiveHostsFromLedger();
    }

    async getHostInfo(hostAddress) {
        const host = await this.#registryClient.getHostInfo(hostAddress);

        if (!host)
            throw 'Host not found.';

        return host;
    }

    async getTenantSequence() {
        return await this.#tenantClient.xrplAcc.getSequence();
    }

    getTenantAddress() {
        return this.#tenantClient.xrplAcc.address;
    }

    async getHostLeases(hostAddress) {
        const hostClient = new evernode.HostClient(hostAddress);
        return await hostClient.getLeaseOffers();
    }

    getLatestLedgerIndex() {
        return this.#xrplApi.ledgerIndex;
    }

    async getEVRBalance() {
        const client = new evernode.TenantClient(this.getTenantAddress());
        await client.connect();
        const balance = await client.getEVRBalance();
        await client.disconnect();
        return balance;
    }

    async acquire(hostAddress, moments, ownerPubkey, contractId = uuid.v4(), instanceImage = appenv.instanceImage, config = {}, options = {}) {
        if (!this.#tenantClient)
            throw "Tenant account is not initialized.";

        let requirement = {
            owner_pubkey: ownerPubkey,
            contract_id: contractId,
            image: instanceImage,
            config: config
        };

        const acquireOptions = {
            leaseOfferIndex: options.leaseIndex,
            transactionOptions: { sequence: options.tenantSequence }
        };
        
        if (options.sendMax !== undefined && options.sendMax !== null)
            acquireOptions.sendMax = options.sendMax;
        
        const result = await this.#tenantClient.acquireLease(hostAddress, requirement, acquireOptions);
        const acquiredTimestamp = Date.now();
        const instanceName = result.instance.name;

        // Assign ip to domain and outbound_ip for instance created from old sashimono version.
        if ('ip' in result.instance) {
            result.instance.domain = result.instance.ip;
            delete result.instance.ip;
        }

        if (moments > 1 && instanceName) {
            const extendRes = await this.extend(hostAddress, instanceName, moments - 1);
            info(`Extending the instance for ${moments - 1} ${moments === 2 ? 'moment' : 'moments'}. Expiry moment: ${extendRes.expiryMoment}`);
        }

        return { ...result.instance, created_timestamp: acquiredTimestamp };
    }

    async extend(hostAddress, instanceName, moments, options = {}) {
        if (!this.#tenantClient)
            throw "Tenant account is not initialized.";

        const result = await this.#tenantClient.extendLease(hostAddress, moments, instanceName, { transactionOptions: { sequence: options.tenantSequence } });
        return result;
    }

    async setSigners(signers, quorum, size, options = {}) {
        if (!this.#tenantClient)
            throw "Tenant account is not initialized.";

        if (signers.length == 0)
            for (let i = 0; i < size; i++) {
                const acc = generateAccount();
                signers.push({ ...acc, weight: 1 });
            }

        if (signers.length < 1)
            throw ("Signer list is empty.")

        if (quorum < 1)
            throw ("Signer quorum must be a positive integer.");


        await this.#tenantClient.xrplAcc.setSignerList(signers.map((n) => { return { account: n.account, weight: n.weight } }), { signerQuorum: quorum }, options);
        return signers;
    }

    async checkHostRealAliveness(hostAddress, currentTimestamp, currentLedgerIndex, timeLimit) {
        const hostAccount = await new evernode.XrplAccount(hostAddress);
        const endLedgerIndex = currentLedgerIndex - (LEDGERS_PER_HOUR * timeLimit);

        let oldestAliveTimestamp = currentTimestamp;
        let continuousAliveness = false;

        if (endLedgerIndex > 0) {
            const transactionHistory = await hostAccount.getAccountTrx(endLedgerIndex, currentLedgerIndex, false);

            // Filter the HEARTBEAT transactions.(Descending ordered list based on ledger index)
            const heartbeatTxns = transactionHistory.map((record) => {
                const transaction = record.tx;
                transaction.Memos = evernode.TransactionHelper.deserializeMemos(transaction.Memos);
                transaction.HookParameters = evernode.TransactionHelper.deserializeHookParams(transaction.HookParameters);
                transaction.Timestamp = transaction.date + XRPL_TIMESTAMP_OFFSET;
                const paramValues = transaction.HookParameters.map(p => p.value);
                if (paramValues.includes(evernode.EventTypes.HEARTBEAT)) {
                    return transaction;
                }
            }).filter(n => n);

            for (let i = 0; i < heartbeatTxns.length; i++) {
                if (i == 0 && (currentTimestamp - heartbeatTxns[i].Timestamp >= (3600 + 300))) {
                    continuousAliveness = false;
                    break;
                }

                if (i > 0) {
                    if (heartbeatTxns[i - 1].Timestamp - heartbeatTxns[i].Timestamp >= (3600 + 300)) {
                        // Filter the in between transactions performed on Registry Account.
                        const secondaryTxns = (await hostAccount.getAccountTrx(heartbeatTxns[i].ledger_index, heartbeatTxns[i - 1].ledger_index, false)).filter(n => n.tx.Destination == this.#registryClient.xrplAcc.address);
                        if (secondaryTxns.length == 0 || (secondaryTxns[0].tx.date + XRPL_TIMESTAMP_OFFSET) - heartbeatTxns[i].Timestamp >= 1800) {
                            continuousAliveness = false;
                            break;
                        }
                    }

                    continuousAliveness = true;
                    oldestAliveTimestamp = heartbeatTxns[i].Timestamp;
                }
            }
        }

        const aliveTime = currentTimestamp - oldestAliveTimestamp;
        const hours = Math.floor(aliveTime / 3600);
        const minutes = Math.floor((aliveTime % 3600) / 60);

        return {
            uptime: `${hours}:${minutes.toString().padStart(2, '0')}`,
            aliveness: continuousAliveness
        };
    }
}

module.exports = {
    EvernodeManager
};

