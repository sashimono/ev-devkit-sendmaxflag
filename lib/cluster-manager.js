const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const uuid = require('uuid');
const path = require('path');
const { EvernodeManager } = require("./evernode-manager");
const { info, log, error } = require("./logger");
const appenv = require('../appenv');
const { generateKeys } = require("./common");

const BLACKLIST_SCORE_THRESHOLD = 3;

const NodeStatus = {
    NONE: 0,
    CREATED: 1,
    CONFIGURED: 2,
    ACKNOWLEDGED: 3,
    ADDED_TO_UNL: 4
}

const ClusterOwner = {
    NONE: 0,
    SELF_MANAGER: 1
}

const LifePlan = {
    STATIC: 'stat',
    INCREMENTAL: 'inc',
    RANDOM: 'rand',
}

class ClusterManager {
    #size;
    #tenantSecret;
    #ownerPrivateKey;
    #moments;
    #contractId;
    #instanceImage;
    #config;
    #hosts;

    multisig;
    #quorum;
    #signerCount;
    #signerMoments;

    #lifePlan
    #lifeGap
    #minLifeMoments;
    #maxLifeMoments;

    #nodes;
    #evernodeMgr;
    #signers;
    #evrBalance;
    #leaseAmounts;

    constructor(options = {}) {
        this.#size = options.size || 3;
        this.#tenantSecret = options.tenantSecret;
        this.#ownerPrivateKey = options.ownerPrivateKey;
        this.#moments = options.moments || 1;
        this.#contractId = options.contractId || uuid.v4();
        this.#instanceImage = options.instanceImage || appenv.instanceImage;
        this.#config = options.config || {};
        this.multisig = options.multisig || false;
        this.#lifePlan = options.lifePlan || LifePlan.STATIC;
        this.#evrBalance = options.evrLimit != null ? options.evrLimit : null;
        this.#leaseAmounts = [];

        if (this.#lifePlan == LifePlan.RANDOM) {
            this.#minLifeMoments = options.minLifeMoments || this.#moments;
            this.#maxLifeMoments = options.maxLifeMoments || this.#moments;
        } else if (this.#lifePlan == LifePlan.INCREMENTAL) {
            this.#lifeGap = options.lifeGap;
        }

        if (this.multisig) {
            this.#signers = options.signers || [];
            this.#signerCount = this.#signers.length || options.signerCount || this.#size;
            // Required minimum accumulated weight for txn submission.
            // Quorum = quorum as a ratio * sum of weights
            this.#quorum = (this.#signers.length > 0)
                ? Math.ceil(options.quorum * (this.#signers.reduce(function (acc, s) { return acc + s.weight }, 0)))
                : Math.ceil(options.quorum * this.#signerCount); // Here we consider the signer weight as 1. Hence the sum of weight will be equal to `this.#signerCount`.
            this.#signerMoments = options.signerMoments || this.#moments;
        }
    }

    async init(hostAddresses) {
        if (!this.#tenantSecret)
            throw "Tenant secret is missing!";
        else if (!this.#ownerPrivateKey)
            throw "Owner private key is missing!";
        else if (!this.#instanceImage)
            throw "Instance image is missing!";

        this.#evernodeMgr = new EvernodeManager({
            tenantSecret: this.#tenantSecret
        });
        await this.#evernodeMgr.init();

        const hostList = (await this.#evernodeMgr.getActiveHosts(hostAddresses)).filter(h => h.maxInstances > h.activeInstances);
        this.#hosts = hostList.reduce((map, host) => {
            host.blacklistScore = 0;
            map[host.address] = host;
            return map;
        }, {});

        this.#nodes = [];
    }

    async terminate() {
        if (this.#evernodeMgr)
            await this.#evernodeMgr.terminate();
    }

    getClusterInfoCachePath() {
        const createRef = crypto.createHash('md5').update(process.argv.join()).digest('hex');
        const tmpClusterDir = `${os.tmpdir()}/evdevkit-cluster`;
        const tmpClusterName = `partial-cluster-${createRef}.json`;
        return `${tmpClusterDir}/${tmpClusterName}`;
    }

    cacheClusterInfo() {
        const cachePath = this.getClusterInfoCachePath();
        const cacheDir = path.dirname(cachePath);

        if (!fs.existsSync(cacheDir))
            fs.mkdirSync(cacheDir);

        fs.writeFileSync(cachePath, JSON.stringify(this.#nodes, null, 4));
    }

    getClusterInfoCache() {
        const cachePath = this.getClusterInfoCachePath();

        return fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath)) : [];
    }

    clearClusterInfoCache() {
        const cachePath = this.getClusterInfoCachePath();

        if (fs.existsSync(cachePath))
            fs.rmSync(cachePath);
    }

    async #createNode(hostAddress, ownerPubKey, config = {}, leaseOfferIndex = null, tenantSequence = null) {
        // Set consensus mode to public since primary node need to send proposals to others.
        if (!config.contract)
            config.contract = {};
        if (!config.contract.consensus)
            config.contract.consensus = {};
        config.contract.consensus.mode = "public";

        return await this.#evernodeMgr.acquire(
            hostAddress,
            1,
            ownerPubKey,
            this.#contractId,
            this.#instanceImage,
            config,
            { tenantSequence: tenantSequence, leaseOfferIndex: leaseOfferIndex });
    }

    async #extendCluster() {
        let tenantSequence = await this.#evernodeMgr.getTenantSequence();
        const assignedLives = [];
        let success = true;

        await Promise.all(this.#nodes.map(async (node, i) => {
            await new Promise(resolve => setTimeout(resolve, 500 * i));
            try {
                let life;
                switch (this.#lifePlan) {
                    case LifePlan.RANDOM: {
                        const isFarEnough = (lifeValue, lifeArray, minimumDistance) => {
                            if (lifeArray.length == 0)
                                return true;
                            for (let i = 0; i < lifeArray.length; i++) {
                                if (Math.abs(lifeValue - lifeArray[i]) < minimumDistance) {
                                    return false;
                                }
                            }
                            return true;
                        }

                        life = Math.floor(
                            Math.random() * (this.#maxLifeMoments - this.#minLifeMoments) + this.#minLifeMoments);
                        while (!isFarEnough(life, assignedLives, 1)) {
                            life = Math.floor(
                                Math.random() * (this.#maxLifeMoments - this.#minLifeMoments) + this.#minLifeMoments);
                        }
                        assignedLives.push(life)
                        break;
                    }

                    case LifePlan.INCREMENTAL: {
                        life = 1 + i * this.#lifeGap;
                        break;
                    }

                    default: {
                        life = node.signer_detail ? this.#signerMoments : this.#moments;
                        break;
                    }
                }

                if (life > 1) {
                    info(`Extending ${node.name} by ${life - 1} moments...`);
                    await this.#evernodeMgr.extend(node.host, node.name, life - 1, { tenantSequence: tenantSequence++ });
                }
                node.life_moments = life;
            }
            catch (e) {
                success = false;
                error(e.reason || e);
            }
        }));

        return success;
    }

    async #createClusterChunk(chunkSize = 1, optimalNodes) {
        const nodes = [];
        const curNodeCount = this.#nodes.length;
        let tenantSequence = await this.#evernodeMgr.getTenantSequence();

        await Promise.all(Array(chunkSize).fill(0).map(async (v, i) => {
            await new Promise(resolve => setTimeout(resolve, 1000 * i));

            const host = optimalNodes[i % optimalNodes.length];
            const nodeNumber = curNodeCount + i + 1;
            let nodeNumberText = nodeNumber;
            if (Math.floor(nodeNumber / 10) != 1 && nodeNumber % 10 === 1)
                nodeNumberText += 'st';
            else if (Math.floor(nodeNumber / 10) != 1 && nodeNumber % 10 === 2)
                nodeNumberText += 'nd';
            else if (Math.floor(nodeNumber / 10) != 1 && nodeNumber % 10 === 3)
                nodeNumberText += 'rd';
            else
                nodeNumberText += 'th';
            try {
                info(`Creating ${nodeNumberText} node on host ${host.address}...`);

                const hostLeases = await this.#evernodeMgr.getHostLeases(host.address);
                const selectedLeaseIndex = hostLeases && hostLeases[0] && hostLeases[0].index;
                if (!selectedLeaseIndex)
                    throw "No offers available.";

                let config = JSON.parse(JSON.stringify(this.#config));
                if (!config.mesh) config.mesh = {}

                if (this.#nodes.length > 0) {
                    const primaryNode = this.#nodes[0];
                    config.mesh.known_peers = [`${primaryNode.domain}:${primaryNode.peer_port}`];

                    // If the cluster does not require multi-sig feature, then we can allow other nodes to sync with primary node from the beginning.
                    if (!this.multisig) {
                        if (!config.contract) config.contract = {}
                        config.contract.unl = [primaryNode.pubkey];
                    }
                }

                // Set random user keys for the secondary nodes.
                let userKeys = await generateKeys((this.multisig && this.#nodes.length > 0) ? null : this.#ownerPrivateKey, 'hex');

                const result = await this.#createNode(host.address, userKeys.publicKey, config, selectedLeaseIndex, tenantSequence++);

                info(`${nodeNumberText} node created! Name: ${result.name}`);
                nodes.push({ host: host.address, userKeys: userKeys, ...result });
                this.#hosts[host.address].activeInstances++;
            }
            catch (e) {
                log(`${nodeNumberText} node creation failed!`, e.reason || e);
                this.#hosts[host.address].blacklistScore += this.#incrementBlacklistScore(e.reason);
            }

            if (this.#evrBalance != null) {
                this.#evrBalance -= host.leaseAmount;
            }
        }));
        return nodes;
    }

    #incrementBlacklistScore(reason = null) {
        const instantBanReasons = ['max_alloc_reached', 'HOST_INVALID'];
        if (instantBanReasons.includes(reason))
            return BLACKLIST_SCORE_THRESHOLD;
        else
            return 1;
    }

    #estimateCost(preferredHosts, targetSize, returnNodes = false) {
        if (!preferredHosts || preferredHosts.length == 0)
            throw `All hosts are invalid or occupied.`;

        let optimalCost = 0;
        let optimalNodes = [];

        let totalInstances = 0;
        for (const host of preferredHosts) {
            totalInstances += host.availableInstances;
        }

        if (targetSize > totalInstances)
            throw `Number of available instances of the preferred hosts is insufficient to create the cluster.`


        while (optimalNodes.length < targetSize) {
            for (let hostIndex in preferredHosts) {
                let host = preferredHosts[hostIndex]
                if (host.availableInstances > 0 && optimalNodes.length < targetSize) {
                    optimalNodes.push(host);
                    optimalCost += Number(host.leaseAmount);
                    host.availableInstances -= 1;
                }
            }
        }

        optimalCost *= this.#moments;

        if (this.#evrBalance != null && optimalCost > this.#evrBalance)
            throw `Defined EVR limit is insufficient. Estimated cost for remaining node creation: ${optimalCost}`

        if (returnNodes)
            return optimalNodes;
        else
            info(`EVR cost estimated for cluster creation: ${optimalCost}`);
    }

    async #checkFeasibility(targetSize, preferredHostsArray) {
        let hosts = [];

        hosts = Object.values(this.#hosts).filter((host) => host.maxInstances > host.activeInstances);

        let preferredHosts = preferredHostsArray.map(ph => hosts.find(h => h.address === ph)).filter(h => h);
        for (const host of preferredHosts) {
            host.availableInstances = host.maxInstances - host.activeInstances;
            this.#leaseAmounts.push({ host: host.address, leaseAmount: host.leaseAmount })
        }
        preferredHosts = preferredHosts.map(({ address, availableInstances, leaseAmount }) => ({ address, availableInstances, leaseAmount }))
            .filter(h => h.leaseAmount != null).sort((a, b) => a.leaseAmount - b.leaseAmount);

        this.#estimateCost(preferredHosts, targetSize);
    }

    #getOptimalNodesList(targetSize, preferredHostsArray) {
        const hosts = Object.values(this.#hosts).filter((host) => host.blacklistScore < BLACKLIST_SCORE_THRESHOLD &&
            host.maxInstances > host.activeInstances);

        let preferredHosts = preferredHostsArray.map(ph => hosts.find(h => h.address === ph)).filter(h => h);
        for (const host of preferredHosts) {
            host.availableInstances = host.maxInstances - host.activeInstances;

            if (this.#evrBalance != null)
                host.leaseAmount = this.#leaseAmounts.find(la => la.host === host.address)?.leaseAmount || null;

            host.nodes = this.#nodes.filter((node) => node.host === host.address).length;
        }
        preferredHosts = preferredHosts.map(({ address, availableInstances, leaseAmount, nodes }) => ({ address, availableInstances, leaseAmount, nodes }));

        if (this.#evrBalance != null)
            preferredHosts = preferredHosts.filter(h => h.leaseAmount != null).sort((a, b) => a.leaseAmount - b.leaseAmount || a.nodes - b.nodes);
        else
            preferredHosts = preferredHosts.sort((a, b) => a.nodes - b.nodes);

        const optimalNodes = this.#estimateCost(preferredHosts, targetSize, true);

        return optimalNodes;
    }

    async createCluster(preferredHostsArray, recover = false) {
        if (recover) {
            const nodes = this.getClusterInfoCache();
            if (nodes.length > 0) {
                this.#nodes.push(...nodes);
                this.#contractId = nodes[0].contract_id;
            }
        }

        let targetSize = this.#size - this.#nodes.length;

        //Initial feasibility check before cluster creation
        if (this.#evrBalance != null) {
            await this.#checkFeasibility(targetSize, preferredHostsArray);
        }

        while (targetSize > 0) {
            const chunkSize = Math.min((targetSize == this.#size ? 1 : targetSize), preferredHostsArray.length)
            const optimalNodes = this.#getOptimalNodesList(chunkSize, preferredHostsArray);

            if (optimalNodes.length == 0)
                throw 'No available optimal nodes to acquire.';

            const nodes = await this.#createClusterChunk(chunkSize, optimalNodes);
            this.#nodes.push(...nodes);

            this.cacheClusterInfo();

            targetSize -= nodes.length;
        }

        // Set the signers if the cluster requires multi-sig feature.
        if (this.multisig) {

            this.#signers = await this.#evernodeMgr.setSigners(this.#signers, this.#quorum, this.#signerCount);

            // Map the signers to nodes. (No any order)
            for (let i = 0; i < this.#signerCount; i++) {
                this.#nodes[i].signer_detail = this.#signers[i];
            }

            this.cacheClusterInfo();
        }

        info(`Extending the nodes life...`);
        if (!(await this.#extendCluster())) {
            this.cacheClusterInfo();

            throw 'Error occurred while extending the nodes.';
        }
        else {
            this.cacheClusterInfo();
        }

        return this.#nodes;
    }

    async writeSigner(destination, nodePubkey) {
        const normalizedPath = path.normalize(destination);
        const node = this.#nodes.find(n => n.pubkey === nodePubkey && n.hasOwnProperty('signer_detail'));
        if (node)
            fs.writeFileSync(normalizedPath, JSON.stringify(node.signer_detail, null, 4));
    }

    getTenantAddress() {
        return this.#evernodeMgr.getTenantAddress();
    }
}

module.exports = {
    ClusterManager,
    NodeStatus,
    ClusterOwner,
    LifePlan
};

