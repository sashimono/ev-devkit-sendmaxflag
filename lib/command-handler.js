const fs = require('fs');
const path = require('path');
const uuid = require('uuid');
const appenv = require('../appenv');
const { exec } = require("./child-proc");
const { ClusterManager, NodeStatus, ClusterOwner, LifePlan } = require('./cluster-manager');
const { CONSTANTS, bundleContract, generateKeys, validateArrayElements, removeDirectorySync, questionSync } = require("./common");
const { EvernodeManager } = require("./evernode-manager");
const { InstanceManager } = require('./instance-manager');
const { error, info, success, log } = require("./logger");
const { TimeTracker } = require("./timetracker");

const NODES_BUNDLE_PATH = `./nodes/`;
const DEFAULT_QUORUM = 0.8;
const MAX_UPLOAD_TRIES = 5;
const DEFAULT_LIFE_GAP = 2; // Number of Moments
const MAX_LIFE_UPPER_BOUND = 48; // Number of Moments
const DEFAULT_OPERATIONAL_TIME_BOUND = 48; // Number of Hours


function version() {
    info(`command: version`);

    try {
        const res = exec(`npm -g list ${CONSTANTS.npmPackageName} --depth=0`);
        const splitted = res.toString().split('\n');
        if (splitted.length > 1) {
            success(`\n${splitted[1].split('@')[1]}\n`);
            return;
        }
    }
    catch (e) {
        error('Error getting the version info:', e);
    }

    error(`\n${CONSTANTS.npmPackageName} is not installed.`);
}

async function list(options) {
    info(`command: list`);

    if (options.desc && !options.orderBy) {
        error('orderBy option is required to order in descending manner.');
        return;
    }

    let evernodeMgr;
    try {
        evernodeMgr = new EvernodeManager();
        await evernodeMgr.init();
        const hosts = await evernodeMgr.getActiveHostsFromLedger().catch(error);

        if (hosts) {
            let formatted = hosts.map(h => {
                return {
                    address: h.address,
                    domain: h.domain,
                    ram: `${h.ramMb} MB`,
                    storage: `${h.diskMb} MB`,
                    cpu: {
                        model: h.cpuModelName,
                        time: `${h.cpuMicrosec} us`,
                        cores: h.cpuCount,
                        speed: `${h.cpuMHz} MHz`
                    },
                    sashimonoVersion: h.version,
                    countryCode: h.countryCode,
                    totalInstanceSlots: h.maxInstances,
                    availableInstanceSlots: h.maxInstances - h.activeInstances,
                    leaseFee: h.leaseAmount,
                    reputation: h.hostReputation,
                }
            });

            if (formatted.length > 0 && options.orderBy && !(options.orderBy in formatted[0]))
                error(`Host info does not contain a key named ${options.orderBy}.`);

            if (options.orderBy)
                formatted = formatted.filter(h => h[options.orderBy]).sort((a, b) => ((a[options.orderBy] - b[options.orderBy]) * (options.desc ? -1 : 1)));

            log(formatted.slice(0, options.limit).map(h => {
                if (!options.props)
                    return h;

                const keys = options.props.split(',').filter(k => k in h);
                let obj = {};
                for (const key of keys) {
                    obj[key] = h[key];
                }
                return obj;
            }));
        }
    }
    catch (e) {
        error('Error occurred while getting the host list:', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function hostInfo(options) {
    info(`command: info`);

    let evernodeMgr;
    try {
        let hostsToSearch = [];
        let tempFileName = `hostDetails_${Date.now()}.csv`;

        if (!options.filePath && !options.hostAddress)
            throw 'Either host address or file path is required to search for host info.';

        if (options.filePath) {
            if (!fs.existsSync(options.filePath) || !fs.statSync(options.filePath).isFile())
                throw `Hosts file ${options.filePath} does not exists.`;

            hostsToSearch = options.filePath ? fs.readFileSync(options.filePath, 'UTF-8').split(/\r?\n/).filter(h => h) : [];
        }

        if (options.hostAddress && (typeof options.hostAddress !== 'string' || options.hostAddress.trim() === ''))
            throw 'Host address should be a non-empty string.';

        hostsToSearch.push(options.hostAddress);

        if (options.output && (!(fs.existsSync(options.output) && fs.statSync(options.output).isDirectory())))
            throw `Output path ${options.output} does not exist or is not a directory.`;

        evernodeMgr = new EvernodeManager();

        await evernodeMgr.init();

        // Fetch all host details in parallel
        const allHostDetails = await Promise.all(
            hostsToSearch.map(async (hostAddress) => {
                try {
                    const host = await evernodeMgr.getHostInfo(hostAddress);
                    if (host) {
                        return {
                            address: host.address,
                            domain: host.domain,
                            ram: `${host.ramMb} MB`,
                            storage: `${host.diskMb} MB`,
                            cpu: {
                                model: host.cpuModelName,
                                time: `${host.cpuMicrosec} us`,
                                cores: host.cpuCount,
                                speed: `${host.cpuMHz} MHz`
                            },
                            sashimonoVersion: host.version,
                            countryCode: host.countryCode,
                            totalInstanceSlots: host.maxInstances,
                            availableInstanceSlots: host.maxInstances - host.activeInstances,
                            active: host.active
                        };
                    }
                } catch (error) {
                    console.error(`Error fetching details for host ${hostAddress}:`, error);
                }
            })
        );

        const validHostDetails = allHostDetails.filter(host => host !== undefined);

        // Write them to the CSV file
        if (options.output && validHostDetails.length > 0) {
            tempFileName = path.join(options.output, tempFileName);

            const csvHeader = [
                'Address', 'Domain', 'RAM', 'Storage', 'CPU Model', 'CPU Time',
                'CPU Cores', 'CPU Speed', 'Sashimono Version', 'Country Code',
                'Total Instance Slots', 'Available Instance Slots', 'Active'
            ];

            const csvData = validHostDetails.map(host => [
                host.address,
                host.domain,
                host.ram,
                host.storage,
                host.cpu.model,
                host.cpu.time,
                host.cpu.cores,
                host.cpu.speed,
                host.sashimonoVersion,
                host.countryCode,
                host.totalInstanceSlots,
                host.availableInstanceSlots,
                host.active
            ]);

            // Convert header and data into CSV format
            const csvContent = [csvHeader, ...csvData].map(row => row.join(',')).join('\n');

            // Write the CSV string to the temporary file
            fs.writeFile(tempFileName, csvContent, (err) => {
                if (err) {
                    console.error('Error writing to the CSV file:', err.message);
                } else {
                    console.log('CSV file written successfully.');
                }
            });
        }

        log(validHostDetails);

    }
    catch (e) {
        error('Error occurred while getting the host info:', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function keygen() {
    info(`command: keygen`);

    try {
        const keys = await generateKeys();
        success('New key pair generated', keys);
        info('Record these keys and set the private key to the environment variable called EV_USER_PRIVATE_KEY for future operations.');
    }
    catch (e) {
        error('Error occurred while generating key pair:', e);
    }
}

async function acquire(host, options) {
    info(`command: acquire`);

    let evernodeMgr;
    try {
        evernodeMgr = new EvernodeManager({
            tenantSecret: appenv.tenantSecret
        });

        await evernodeMgr.init();
        const userKeys = await generateKeys(appenv.userPrivateKey, 'hex');
        const result = await evernodeMgr.acquire(
            host,
            options.moments || 1,
            userKeys.publicKey,
            options.contractId,
            options.image,
            appenv.hpInitCfg || {}),
            { sendMax: options.sendmax });
        success('Instance created!', result);
    }
    catch (e) {
        error('Error occurred while acquiring the instance:', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function extend(instancesFilePath, options) {
    info(`command: extend`);

    let evernodeMgr;
    try {
        if (!instancesFilePath || !fs.existsSync(instancesFilePath))
            throw 'Instance file path does not exist.';

        evernodeMgr = new EvernodeManager({
            tenantSecret: appenv.tenantSecret
        });

        await evernodeMgr.init();
        const moments = options?.moments ? options.moments : 1;

        // Read contents of the file
        const data = fs.readFileSync(instancesFilePath, 'UTF-8');
        // Split the contents by new line
        const instances = data.split(/\r?\n/).filter(e => e);

        await Promise.all(instances.map(async (line, i) => {
            await new Promise(resolve => setTimeout(resolve, 1000 * i));
            try {
                let [hostAddress, instanceName, life] = line.split(":");
                hostAddress = hostAddress.trim();
                instanceName = instanceName.trim();
                if (life)
                    life = life.trim();

                if (!hostAddress || !instanceName)
                    throw 'Host address and instance name are required.';
                if (life && isNaN(life))
                    throw 'Moment life should be a integer number.';
                else if (life) {
                    life = Number(life);
                    if (!Number.isInteger(life))
                        throw 'Moment life should be a integer number.';
                }
                else {
                    life = moments;
                }

                const result = await evernodeMgr.extend(hostAddress, instanceName, life);
                info(`Extending the instance for ${life} ${life === 1 ? 'moment' : 'moments'}.`);
                success(`Extension txn Ref: ${result.extendRefId}\nExpiry moment: ${result.expiryMoment}`);
            }
            catch (e) {
                error(e.reason || e);
            }
        }));
    }
    catch (e) {
        error('Error occurred while extending the instance:.', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function extendInstance(hostAddress, instanceName, options) {
    info(`command: extend`);

    let evernodeMgr;
    try {
        evernodeMgr = new EvernodeManager({
            tenantSecret: appenv.tenantSecret
        });

        await evernodeMgr.init();
        const moments = options?.moments ? options.moments : 1;
        const result = await evernodeMgr.extend(hostAddress, instanceName, moments);
        info(`Extending the instance for ${moments} ${moments === 1 ? 'moment' : 'moments'}.`);
        success(`Extension txn Ref: ${result.extendRefId}\nExpiry moment: ${result.expiryMoment}`);
    }
    catch (e) {
        error('Error occurred while extending the instance:.', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function audit(options) {
    info(`command: audit`);
    let hostsToAudit = [];
    let auditResults = [];
    let totalAmount = 0;
    let evernodeMgr, evrBalance;

    const errorDescription = {
        1: 'Host inactive',
        2: 'Host invalid (not registered)',
        3: 'No lease offer',
        4: 'Timeout during Acquire',
        5: 'User Install error during Acquire',
        6: 'Transaction failed',
        7: 'Insufficient funds during Acquire',
        8: 'Connection failed during auditing',
        9: 'Transaction failed due to timeout',
        100: 'Unknown error',
        'N/A': 'Not Applicable'
    };
    const errorMap = {
        'HOST_INACTIVE': 1,
        'HOST_INVALID': 2,
        'NO_OFFER': 3,
        'TIMEOUT': 4,
        'user_install_error': 5,
        'TRANSACTION_FAILURE': 6,
        'TRANSACTION_FAILURE (tecINSUFFICIENT_FUNDS)': 7,
        'Connection failed': 8,
        'TRANSACTION_FAILURE (TimeoutError)': 9,
        'N/A': 'N/A'
    };

    const expectedOperationalTime = options?.opTime ? options.opTime : DEFAULT_OPERATIONAL_TIME_BOUND;

    try {
        if (options.filePath) {
            if (!fs.existsSync(options.filePath) || !fs.statSync(options.filePath).isFile())
                throw `Hosts file ${options.filePath} does not exists.`;

            hostsToAudit = options.filePath ? fs.readFileSync(options.filePath, 'UTF-8').split(/\r?\n/).filter(h => h) : [];
        }

        if (options.hostAddress)
            hostsToAudit.push(options.hostAddress);

        if (!hostsToAudit || hostsToAudit.length == 0)
            throw `No hosts specified to audit.`;

        evernodeMgr = new EvernodeManager({
            tenantSecret: (options?.aliveness) ? null : appenv.tenantSecret
        });

        await evernodeMgr.init();
        let userKeys;
        if (!options?.aliveness)
            userKeys = await generateKeys(appenv.userPrivateKey, 'hex');

        const defaultValue = 'N/A';
        const auditStatus = ['Success', 'Failed', 'Cannot Audit'];

        const AuditResult = (hostAddress, status, alivenessData, timeAcquire = defaultValue, timeReadRequestResponse = defaultValue, timeContractResponse = defaultValue, hpVersion = defaultValue, ledgerSeqNo = defaultValue, errorMessage = defaultValue, inactiveStatus = null) => {
            return {
                "HOST ADDRESS": hostAddress,
                "STATUS": inactiveStatus || auditStatus[status],
                "CONT_ALIVENESS": alivenessData.aliveness,
                "SUSTAINED_UP_TIME (H:m)": alivenessData.uptime,
                "ACQUISITION DURATION (s)": timeAcquire,
                "READ RES DURATION (s)": timeReadRequestResponse,
                "CONTRACT RES DURATION (s)": timeContractResponse,
                "HP VER": hpVersion,
                "LEDGER SEQ NO": ledgerSeqNo,
                "ERROR": errorMap[errorMessage] || '100'
            }
        }

        const AlivenessResult = (hostAddress, alivenessData) => {
            return {
                "HOST ADDRESS": hostAddress,
                "CONT_ALIVENESS": alivenessData.aliveness,
                "SUSTAINED_UP_TIME (H:m)": alivenessData.uptime
            }
        }

        if (!options?.aliveness) {
            evrBalance = parseFloat(await evernodeMgr.getEVRBalance());
            for (let hostIndex in hostsToAudit) {
                const hostAddress = hostsToAudit[hostIndex];
                const leases = await evernodeMgr.getHostLeases(hostAddress);
                if (leases.length === 0) {
                    totalAmount += 0;
                } else {
                    const amountValue = parseFloat(leases[0].Amount.value);
                    if (!isNaN(amountValue)) {
                        totalAmount += amountValue;
                    } else {
                        console.error('Invalid amount value in the first lease:', leases[0].Amount.value);
                    }
                }

            }
            if (evrBalance < totalAmount) {
                console.log(`Not enough EVRs to proceed.\nNeed ${totalAmount} EVRs.\nBut you have only ${evrBalance} EVRs.`)
                process.exit(1);
            }
            else {
                const answer = await questionSync(`It will cost ${totalAmount} EVRs from your account for the Audit. Do you wish to proceed [Y/n] ? `);
                if ((answer.trim().toLowerCase() === 'n')) {
                    console.log("Exiting...");
                    process.exit(0);
                }
                else if (answer.trim().toLowerCase() !== 'y' && answer.trim() !== '') {
                    console.log('Invalid input. Please enter either "y" or "n".\nExiting...');
                    process.exit(0);
                }
            }
        }
        const currentTimestamp = (Date.now()) / 1000;
        const latestXrplLedgerIndex = evernodeMgr.getLatestLedgerIndex();
        for (let hostIndex in hostsToAudit) {
            const hostAddress = hostsToAudit[hostIndex];
            const timeTracker = new TimeTracker();
            let timeAcquire, timeContractResponse, timeReadRequestResponse, hpVersion, ledgerSeqNo, status, errorMessage, alivenessData;
            let inactiveStatus = null;
            let instanceMgr;
            try {
                info(`Auditing ${hostAddress} ...`);
                alivenessData = await evernodeMgr.checkHostRealAliveness(hostAddress, currentTimestamp, latestXrplLedgerIndex, expectedOperationalTime);

                if (!options?.aliveness) {
                    timeTracker.start();
                    const result = await evernodeMgr.acquire(
                        hostAddress,
                        1,
                        userKeys.publicKey,
                        uuid.v4(),
                        options.image || appenv.instanceImage,
                        appenv.hpInitCfg || {});
                    success('Instance created!', result);
                    timeAcquire = timeTracker.end();

                    const instanceIp = result.domain;
                    const instanceUserPort = result.user_port;

                    instanceMgr = new InstanceManager({
                        ip: instanceIp,
                        userPort: instanceUserPort,
                        userPrivateKey: appenv.userPrivateKey
                    });

                    await instanceMgr.init();

                    timeTracker.start();
                    const readRequestResponse = await instanceMgr.checkReadRequestBootstrapResponse();
                    if (readRequestResponse == null)
                        throw 'Read request response check failed'
                    timeReadRequestResponse = timeTracker.end();

                    timeTracker.start();
                    const bootstrapStatusResult = await instanceMgr.checkBootstrapStatus();
                    if (bootstrapStatusResult == null)
                        throw 'Bootstrap status response check failed'
                    timeContractResponse = timeTracker.end();

                    const statusResult = await instanceMgr.checkStatus();
                    if (statusResult == null)
                        throw 'Status check failed'

                    status = 0;
                    hpVersion = statusResult.hpVersion;
                    ledgerSeqNo = statusResult.ledgerSeqNo;
                }
            }
            catch (e) {
                status = 1;
                errorMessage = e.reason;
                if (e.reason == 'HOST_INACTIVE') {
                    const hostInfo = await evernodeMgr.getHostInfo(hostAddress);
                    const lastActiveTimestamp = hostInfo?.lastHeartbeatIndex || hostInfo?.registrationTimestamp;
                    const downtime = Math.floor(Date.now() / 1000) - lastActiveTimestamp;
                    const days = Math.floor(downtime / (3600 * 24));
                    const hours = Math.floor((downtime % (3600 * 24)) / 3600);
                    inactiveStatus = `Inactive(${days}D-${hours}H)`;
                }
                else if (e.reason == 'NO_OFFER') {
                    status = 2;
                } else if (typeof e === 'string' && e.includes('connection failed')) {
                    errorMessage = 'Connection failed';
                }
                error(`Error occurred while auditing ${hostAddress}. Error:`, e);
            }
            finally {
                if (options?.aliveness) {
                    auditResults.push(AlivenessResult(hostAddress, alivenessData));

                } else {
                    auditResults.push(AuditResult(hostAddress, status, alivenessData, timeAcquire, timeReadRequestResponse, timeContractResponse, hpVersion, ledgerSeqNo, errorMessage, inactiveStatus));
                    if (instanceMgr)
                        await instanceMgr.terminate();
                }
            }
        }
    }
    catch (e) {
        error('Error occurred while auditing. Error:', e);
    }
    finally {
        if (auditResults && auditResults.length) {
            console.table(auditResults);
            info(`NOTE: Considered ${expectedOperationalTime}Hrs. for the Continuous Aliveness check.`)

            if (!options?.aliveness) {
                info('Error Descriptions:');
                for (const key in errorDescription) {
                    console.log(`${key}: ${errorDescription[key]}`);
                }
            }
        }
        else
            error("No hosts were audited.");
        if (evernodeMgr)
            await evernodeMgr.terminate();
    }
}

async function bundle(contractDirectoryPath, instancePublicKey, contractBin, options) {
    info(`command: bundle`);

    try {
        contractDirectoryPath = path.normalize(contractDirectoryPath);
        const stats = fs.existsSync(contractDirectoryPath) ? fs.statSync(contractDirectoryPath) : null;

        if (!stats || !stats.isDirectory())
            throw `Contract directory ${contractDirectoryPath} does not exists.`;

        const userOverrideCfg = appenv.hpOverrideCfg || {};

        const hpOverrideCfg = {
            ...userOverrideCfg,
            contract: {
                ...(userOverrideCfg.contract || {}),
                unl: [
                    ...(userOverrideCfg.contract?.unl || []),
                    instancePublicKey
                ],
                bin_path: contractBin,
                bin_args: options.contractArgs
            }
        }

        const bundlePath = await bundleContract(
            contractDirectoryPath,
            hpOverrideCfg);
        if (bundlePath)
            success(`Archive finished. (location: ${bundlePath})`);

    } catch (e) {
        error('Error occurred while bundling:', e);
    }

}

async function deploy(contractBundlePath, instanceIp, instanceUserPort) {
    info(`command: deploy`);

    let instanceMgr;
    try {
        instanceMgr = new InstanceManager({
            ip: instanceIp,
            userPort: instanceUserPort,
            userPrivateKey: appenv.userPrivateKey
        });

        await instanceMgr.init();
        await instanceMgr.uploadBundle(contractBundlePath);

        success(`Contract bundle uploaded!`);
    } catch (e) {
        error('Error occurred while uploading the bundle:', e);
    }
    finally {
        if (instanceMgr)
            await instanceMgr.terminate();
    }
}

async function acquireAndDeploy(contractDirectoryPath, contractBin, host, options) {
    info(`command: acquire-and-deploy`);

    let evernodeMgr;
    let instanceMgr;
    try {
        evernodeMgr = new EvernodeManager({
            tenantSecret: appenv.tenantSecret
        });

        contractDirectoryPath = path.normalize(contractDirectoryPath);
        const stats = fs.existsSync(contractDirectoryPath) ? fs.statSync(contractDirectoryPath) : null;

        if (!stats || !stats.isDirectory())
            throw `Contract directory ${contractDirectoryPath} does not exists.`;

        await evernodeMgr.init();

        const hpConfig = appenv.hpInitCfg || {};
        const userOverrideCfg = appenv.hpOverrideCfg || {};

        const userKeys = await generateKeys(appenv.userPrivateKey, 'hex');
        const result = await evernodeMgr.acquire(
            host,
            options.moments || 1,
            userKeys.publicKey,
            options.contractId,
            options.image,
            hpConfig);
        const instancePublicKey = result.pubkey;
        const instanceIp = result.domain;
        const instanceUserPort = result.user_port;
        info('Instance created!', result);

        const hpOverrideCfg = {
            ...userOverrideCfg,
            contract: {
                ...(userOverrideCfg.contract || {}),
                unl: [
                    ...(userOverrideCfg.contract?.unl || []),
                    instancePublicKey
                ],
                bin_path: contractBin,
                bin_args: options.contractArgs
            }
        };

        const bundlePath = await bundleContract(
            contractDirectoryPath,
            hpOverrideCfg);
        if (!bundlePath)
            throw 'Archive failed.';

        info(`Archive finished. (location: ${bundlePath})`);

        instanceMgr = new InstanceManager({
            ip: instanceIp,
            userPort: instanceUserPort,
            userPrivateKey: appenv.userPrivateKey
        });

        await instanceMgr.init();
        await instanceMgr.uploadBundle(bundlePath);

        info(`Contract bundle uploaded!`);
        success(`Contract deployed!`);
    }
    catch (e) {
        error('Error occurred while deploying:', e);
    }
    finally {
        if (evernodeMgr)
            await evernodeMgr.terminate();
        if (instanceMgr)
            await instanceMgr.terminate();
    }
}

async function clusterCreate(size, contractDirectoryPath, contractBin, hostsFilePath, options) {
    info(`command: create-cluster`);

    let clusterMgr;
    let instanceMgr;
    try {
        contractDirectoryPath = path.normalize(contractDirectoryPath);
        const stats = fs.existsSync(contractDirectoryPath) ? fs.statSync(contractDirectoryPath) : null;

        if (!stats || !stats.isDirectory())
            throw `Contract directory ${contractDirectoryPath} does not exist.`;

        if (!hostsFilePath || !fs.existsSync(hostsFilePath))
            throw 'Preferred Host file path does not exist.';

        if (options?.signers && !fs.existsSync(options.signers))
            throw 'Signer Details file path does not exist.';

        if (options?.lifePlan) {
            if (!(Object.values(LifePlan).includes(options.lifePlan)))
                throw 'Invalid cluster node life plan is provided.';

            switch (options.lifePlan) {
                case LifePlan.RANDOM: {
                    info("Randomized node life planning is considered.");

                    if (options?.signerLife)
                        throw 'Defining --signer-life is not applicable in Random life plan.';

                    if (options?.moments)
                        throw 'Defining --moments is not applicable in Random life plan.';

                    if (options?.evrLimit)
                        throw 'Defining --evr-limit is not applicable in Random life plan.';

                    if (options?.lifeGap)
                        throw 'Defining --life-gap is not applicable in Random life plan.';

                    if (!options?.minLife)
                        throw 'Defining --min-life is not applicable in Random life plan.';

                    if (!options?.maxLife) {
                        info(`Default value of --max-life (${MAX_LIFE_UPPER_BOUND} moments) is considered.`)
                        options.maxLife = MAX_LIFE_UPPER_BOUND;
                        options.reactivePruning = true;
                    }

                    const minLife = parseInt(options.minLife);
                    const maxLife = parseInt(options.maxLife);

                    if ((isNaN(minLife) || isNaN(maxLife)) || minLife >= maxLife) {
                        throw 'Invalid range is provided for node life randomization.';
                    }
                    if (minLife <= 0) {
                        throw 'Moment count for --min-life should be greater than 0.';
                    } else if (maxLife - minLife <= size)
                        throw `Provided range does not support for a good node life randomization`;
                    else {
                        options.minLife = minLife;
                        options.maxLife = maxLife;
                    }

                    break;
                }

                case LifePlan.INCREMENTAL: {
                    info("Incremental node life planning is considered.")

                    if (options?.maxLife || options?.minLife)
                        throw 'Defining --min-life or --max-life is not applicable in Incremental life plan.';

                    if (options?.signerLife)
                        throw 'Defining --signer-life is not applicable in Incremental life plan.';

                    if (options?.moments)
                        throw 'Defining --moments is not applicable in Incremental life plan.';

                    if (options?.evrLimit)
                        throw 'Defining --evr-limit is not applicable in Incremental life plan.';

                    if (!options?.lifeGap) {
                        info(`Default value of --life-gap (${DEFAULT_LIFE_GAP} moments) is considered.`)
                        options.lifeGap = DEFAULT_LIFE_GAP
                    } else {
                        options.lifeGap = options.lifeGap > 0 ? options.lifeGap : DEFAULT_LIFE_GAP;
                    }

                    break;
                }

                case LifePlan.STATIC:
                    {
                        info("Static node life planning is considered.")
                        if (options?.maxLife || options?.minLife)
                            throw 'Static life plan does not need the --min-life or --max-life in options.';

                        if (options?.lifeGap)
                            throw 'Static life plan does not require the --life-gap in options.';

                        break;
                    }
            }
        }
        else {
            info("Static node life planning is considered.")
            options.lifePlan = LifePlan.STATIC
            delete options.maxLife;
            delete options.minLife;
            delete options.lifeGap;
        }

        const hpConfig = appenv.hpInitCfg || {};
        const userOverrideCfg = appenv.hpOverrideCfg || {};

        const clusterSpec = {
            size: size,
            evrLimit: options.evrLimit,
            moments: options?.moments ? parseInt(options.moments) : null,
            tenantSecret: appenv.tenantSecret,
            ownerPrivateKey: appenv.userPrivateKey,
            contractId: options.contractId,
            instanceImage: options.image,
            config: hpConfig,
            lifePlan: options.lifePlan
        }

        // If the user wants to make a multi-sig enabled cluster
        if (options?.signers) {
            clusterSpec.multisig = true;
            options.signers = JSON.parse(fs.readFileSync(options.signers));
            if (validateArrayElements(options.signers, ['account', 'secret', 'weight']))
                clusterSpec.signers = options?.signers;
            else {
                throw 'Invalid Signer list';
            }
        }
        else if (options?.signerCount) {
            clusterSpec.multisig = true;
            if (options?.signerCount > 0) {
                const signerCount = parseInt(options?.signerCount);
                if (signerCount <= size)
                    clusterSpec.signerCount = signerCount
                else
                    throw 'Invalid signer count';
            }
            else
                clusterSpec.signerCount = Math.ceil(size / 2);
        }

        if (clusterSpec.lifePlan == LifePlan.RANDOM) {
            clusterSpec.minLifeMoments = options.minLife;
            clusterSpec.maxLifeMoments = options.maxLife;
            clusterSpec.reactivePruning = options?.reactivePruning || false;
        } else if (clusterSpec.lifePlan == LifePlan.INCREMENTAL)
            clusterSpec.lifeGap = options.lifeGap;

        if (clusterSpec.multisig) {
            // Here we consider quorum as a ratio from total weights.
            if (options?.signerQuorum) {
                const quorum = parseFloat(options?.signerQuorum);
                if (quorum > 0 && quorum <= 1)
                    clusterSpec.quorum = quorum;
                else
                    throw 'Invalid Quorum';
            }
            else
                clusterSpec.quorum = DEFAULT_QUORUM;

            if (clusterSpec.lifePlan == LifePlan.STATIC)
                clusterSpec.signerMoments = options?.signerLife ? parseInt(options?.signerLife) : clusterSpec.moments;
        }

        let preferredHostsArray = [];
        try {
            const data = fs.readFileSync(hostsFilePath, 'UTF-8');
            const hosts = data.split(/\r?\n/).filter(h => h);
            preferredHostsArray = hosts.filter((item, index) => hosts.indexOf(item) === index);

        } catch (err) {
            throw 'Invalid host list file format.';
        }

        clusterMgr = new ClusterManager(clusterSpec);
        await clusterMgr.init(preferredHostsArray);
        let result;
        try {
            result = await clusterMgr.createCluster(preferredHostsArray, options && ('recover' in options));
        }
        catch (e) {
            error('Error occurred while creating the cluster', e);
            info(`Partial cluster info saved in ${clusterMgr.getClusterInfoCachePath()}`);
            return;
        }

        instanceMgr = new InstanceManager({
            ip: result[0].domain,
            userPort: result[0].user_port,
            userPrivateKey: result[0].userKeys.privateKey
        });

        if (clusterMgr.multisig) {
            const primaryNode = result[0];

            // Regular expression pattern to match the placeholder
            const placeholderPattern = /<MASTER_ADDRESS>/g;

            // Post Installation Script template with placeholders.
            const postInstallScriptTemplate = `#!/bin/bash
# Post install script.

# Check if <MASTER_ADDRESS>.key file exists and move it to outer level.
if [[ -f ./<MASTER_ADDRESS>.key ]]; then
    mv ./<MASTER_ADDRESS>.key ../<MASTER_ADDRESS>.key
    echo "Moved <MASTER_ADDRESS>.key file in the outer level."
fi

exit 0`;

            const tenantMasterAddress = clusterMgr.getTenantAddress();

            // Prepare the post installation script.
            const postInstallScript = postInstallScriptTemplate.replace(placeholderPattern, tenantMasterAddress);

            // Upload a bundle with making UNL as primary node.
            let uploadCount = 0;
            while (uploadCount < result.length) {
                await Promise.all(
                    result.map(async (node, i) => {
                        if (node.uploaded) {
                            return;
                        }
                        else if (node.uploadTries >= MAX_UPLOAD_TRIES) {
                            node.uploaded = false;
                            uploadCount++;
                            error(`Max tries for uploading to ${node.host} reached. Abandoning upload`);
                            return;
                        }

                        await new Promise(resolve => {
                            setTimeout(resolve, i * 500);
                        });

                        if (!node.bundlePath) {
                            const nodeBundlePath = path.resolve(`${NODES_BUNDLE_PATH}${node.pubkey}/contract_path/`);
                            fs.mkdirSync(nodeBundlePath, { recursive: true });

                            await clusterMgr.writeSigner(`${nodeBundlePath}/${tenantMasterAddress}.key`, node.pubkey);

                            const hpOverrideCfg = {
                                ...userOverrideCfg,
                                contract: {
                                    ...(userOverrideCfg.contract || {}),
                                    unl: [
                                        ...(userOverrideCfg.contract?.unl || []),
                                        primaryNode.pubkey
                                    ],
                                    bin_path: 'bootstrap_contract',
                                    bin_args: node.userKeys.publicKey
                                }
                            };

                            // Replace "exit 0" with "exit 1" in order to add forceful bootstrap upgrade failure in primary node.
                            // exit 1 => Purposely making a bootstrap upgrade failure.
                            let nodePostInstallScript = (primaryNode.pubkey === node.pubkey) ?
                                postInstallScript.replace(/exit 0\b/g, 'exit 1') : postInstallScript;

                            node.bundlePath = await bundleContract(nodeBundlePath, hpOverrideCfg, nodePostInstallScript);
                        }

                        const nodeInstanceMgr = new InstanceManager({
                            ip: node.domain,
                            userPort: node.user_port,
                            userPrivateKey: node.userKeys.privateKey
                        });

                        try {
                            if (!node.uploadTries)
                                node.uploadTries = 1;
                            else
                                node.uploadTries++;

                            await nodeInstanceMgr.init();
                            await nodeInstanceMgr.uploadBundle(node.bundlePath, primaryNode.pubkey === node.pubkey);
                            await nodeInstanceMgr.terminate();

                            node.uploaded = true;
                            uploadCount++;
                        }
                        catch (e) {
                            await nodeInstanceMgr.terminate();
                            error(`Error uploading bundle on node ${node.host}`, e);
                        }
                    })
                );
            }

            const clusterFileContent = result.map((n) => {
                let node = {
                    refId: n.acquire_ref_id,
                    contractId: n.contract_id,
                    status: {
                        status: NodeStatus.CREATED,
                        onLcl: 0
                    },
                    host: n.host,
                    domain: n.domain,
                    name: n.name,
                    peerPort: parseInt(n.peer_port),
                    pubkey: n.pubkey,
                    userPort: parseInt(n.user_port),
                    isUnl: true,
                    isQuorum: !!n.signer_detail,
                    lifeMoments: n.life_moments,
                    maxLifeMoments: 0,
                    targetLifeMoments: n.life_moments,
                    createdMoment: n.created_moment,
                    createdOnTimestamp: n.created_timestamp,
                    owner: ClusterOwner.NONE
                };

                if (n.signer_detail)
                    node.signerAddress = n.signer_detail.account;

                if (n.outbound_ip)
                    node.outboundIp = n.outbound_ip;

                if (clusterSpec.lifePlan == LifePlan.RANDOM) {
                    if (!clusterSpec.reactivePruning)
                        node.maxLifeMoments = Math.floor(Math.random() * (clusterSpec.maxLifeMoments - n.life_moments) + n.life_moments)
                }

                delete n.userKeys;
                delete n.bundlePath;
                delete n.uploadTries;

                return node;
            });

            // Write the relevant files regarding to multi-sig enabling.
            const clusterFilePath = path.resolve(`${contractDirectoryPath}/cluster.json`);
            fs.writeFileSync(clusterFilePath, JSON.stringify({ initialized: true, nodes: clusterFileContent, pendingNodes: [] }, null, 4));

            const multiSigFlagPath = path.resolve(`${contractDirectoryPath}/multisig`);
            fs.writeFileSync(multiSigFlagPath, "MULTISIG");
        }

        info(`Cluster created!`);

        console.log('Waiting 30 seconds until the nodes are synced...');
        await new Promise(resolve => {
            setTimeout(resolve, 30000);
        });

        const hpOverrideCfg = {
            ...userOverrideCfg,
            contract: {
                ...(userOverrideCfg.contract || {}),
                unl: [
                    ...(userOverrideCfg.contract?.unl || []),
                    ...result.map(i => i.pubkey)
                ],
                bin_path: contractBin,
                bin_args: options.contractArgs
            },
            mesh: {
                ...(userOverrideCfg.mesh || {}),
                known_peers: [
                    ...(userOverrideCfg.mesh?.known_peers || []),
                    ...result.map(n => `${n.domain}:${n.peer_port}`)
                ]
            }
        };

        // Upload the requested contract to the created cluster.
        const bundlePath = await bundleContract(
            contractDirectoryPath,
            hpOverrideCfg);
        if (!bundlePath)
            throw 'Archive failed.';

        info(`Archive finished. (location: ${bundlePath})`);

        info('Uploading the contract bundle...');
        let uploaded = false;
        let uploadTries = 0;

        while (!uploaded) {
            if (uploadTries >= MAX_UPLOAD_TRIES)
                throw `Max tries for uploading to ${result[0].host} reached. Abandoning upload`;

            try {
                if (!uploadTries)
                    uploadTries = 1;
                else
                    uploadTries++;

                await instanceMgr.init();
                await instanceMgr.uploadBundle(bundlePath);
                await instanceMgr.terminate();

                uploaded = true;
            }
            catch (e) {
                await instanceMgr.terminate();
                error(`Error uploading bundle on node ${result[0].host}`, e);
            }
        }

        clusterMgr.clearClusterInfoCache();

        info(`Contract bundle uploaded!`);
        success(`Created the ${result.length} node cluster!`, result);
    }
    catch (e) {
        error('Error occurred while creating the cluster:', e);
    }
    finally {
        // Remove the directories of supported bundles.
        removeDirectorySync(NODES_BUNDLE_PATH);

        if (clusterMgr)
            await clusterMgr.terminate();
        if (instanceMgr)
            await instanceMgr.terminate();
    }
}

module.exports = {
    version,
    list,
    hostInfo,
    keygen,
    acquire,
    bundle,
    deploy,
    acquireAndDeploy,
    clusterCreate,
    extend,
    extendInstance,
    audit
};
