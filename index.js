#! /usr/bin/env node

const { program } = require('commander');
const { version, acquire, hostInfo, bundle, keygen, deploy, acquireAndDeploy, clusterCreate, extend, extendInstance, audit } = require('./lib/command-handler');

const ENV_TEXT = 'Environment Variables:';
const REQUIRED_TEXT = 'Required:';
const OPTIONAL_TEXT = 'Optional:';
const TENANT_SECRET_TEXT = 'EV_TENANT_SECRET               Tenant XRPL account secret';
const USER_PRIVATE_KEY_TEXT = 'EV_USER_PRIVATE_KEY            Private key of the contract client (Can be generated using "evdevkit keygen")';
const HP_INIT_CFG_PATH_TEXT = 'EV_HP_INIT_CFG_PATH            File path of the HotPocket configuration for the instance creation';
const HP_OVERRIDE_CFG_PATH_TEXT = 'EV_HP_OVERRIDE_CFG_PATH        File path of the HotPocket configuration for the contract bundle upload';

program.name('evdevkit');

program
    .command('version')
    .description('See evdevkit version')
    .action(version);

/*
program
    .command('list')
    .description('List active hosts in Evernode.')
    .option('-l, --limit [limit]', 'List limit')
    .option('-o, --order-by [order-by]', 'Order by key')
    .option('-d, --desc [desc]', 'Order by descending manner')
    .option('-p, --props [props]', 'Comma separated properties to show')
    .action(list);
*/

program
    .command('hostinfo')
    .description('View host info of a given host or a list of hosts')
    .option('-h, --host-address [host-address]', 'Host address to search for a single host')
    .option('-f, --file-path [file-path]', 'Path to a file containing a list of host addresses (one per line)')
    .option('-o, --output [output]', 'Directory to save the resulting host details')
    .action(hostInfo);

program
    .command('keygen')
    .description('Generate user key pair for HotPocket')
    .action(keygen);

program
    .command('acquire')
    .description('Acquire instance in Evernode')
    .addHelpText('afterAll', `\n${ENV_TEXT}`)
    .addHelpText('afterAll', `  ${REQUIRED_TEXT}
    ${TENANT_SECRET_TEXT}
    ${USER_PRIVATE_KEY_TEXT}`)
    .addHelpText('afterAll', `  ${OPTIONAL_TEXT}
    ${HP_INIT_CFG_PATH_TEXT}`)
    .argument('<host>', 'Host to acquire')
    .option('-m, --moments [moments]', 'Life moments')
    .option('-c, --contract-id [contract-id]', 'Contract id')
    .option('-i, --image [image]', 'Instance image')
    .option('-s, --sendmax [evr]', 'Maximum EVR allowed for acquiring the instance')
    .action(acquire);

program
    .command('bundle')
    .description('Create contract bundle from contract')
    .addHelpText('afterAll', `\n${ENV_TEXT}`)
    .addHelpText('afterAll', `  ${OPTIONAL_TEXT}
    ${HP_OVERRIDE_CFG_PATH_TEXT}`)
    .argument('<contract-path>', 'Absolute path to the contract directory to be bundled')
    .argument('<instance-public-key>', 'Public key of the Evernode instance')
    .argument('<contract-bin>', 'Contract binary name')
    .option('-a, --contract-args [contract-args]', 'Contract binary arguments')
    .action(bundle);

program
    .command('deploy')
    .description('Deploy contract to a Evernode instance')
    .addHelpText('afterAll', `\n${ENV_TEXT}`)
    .addHelpText('afterAll', `  ${REQUIRED_TEXT}
    ${USER_PRIVATE_KEY_TEXT}`)
    .argument('<contract-bundle-path>', 'Absolute path to the contract bundle')
    .argument('<instance-ip>', 'IP address of the Evernode instance')
    .argument('<user-port>', 'User port of the instance')
    .action(deploy);

program
    .command('acquire-and-deploy')
    .description('Acquire instance and deploy contract to a Evernode instance')
    .addHelpText('afterAll', `\n${ENV_TEXT}`)
    .addHelpText('afterAll', `  ${REQUIRED_TEXT}
    ${TENANT_SECRET_TEXT}
    ${USER_PRIVATE_KEY_TEXT}`)
    .addHelpText('afterAll', `  ${OPTIONAL_TEXT}
    ${HP_INIT_CFG_PATH_TEXT}
    ${HP_OVERRIDE_CFG_PATH_TEXT}`)
    .argument('<contract-path>', 'Absolute path to the contract directory to be bundled')
    .argument('<contract-bin>', 'Contract binary name')
    .argument('<host>', 'Host to acquire')
    .option('-a, --contract-args [contract-args]', 'Contract binary arguments')
    .option('-m, --moments [moments]', 'Life moments')
    .option('-c, --contract-id [contract-id]', 'Contract id')
    .option('-i, --image [image]', 'Instance image')
    .option('-s, --sendmax [evr]', 'Maximum EVR allowed for acquiring the instance')
    .action(acquireAndDeploy);

program
    .command('cluster-create')
    .description('Acquire instance cluster and deploy contract')
    .addHelpText('afterAll', `\n${ENV_TEXT}`)
    .addHelpText('afterAll', `  ${REQUIRED_TEXT}
    ${TENANT_SECRET_TEXT}
    ${USER_PRIVATE_KEY_TEXT}`)
    .addHelpText('afterAll', `  ${OPTIONAL_TEXT}
    ${HP_INIT_CFG_PATH_TEXT}
    ${HP_OVERRIDE_CFG_PATH_TEXT}`)
    .argument('<size>', 'Size of the cluster')
    .argument('<contract-path>', 'Absolute path to the contract directory to be bundled')
    .argument('<contract-bin>', 'Contract binary name')
    .argument('<hosts-file-path>', 'File path of preferred host account list (in line-by-line format)')
    .option('-a, --contract-args [contract-args]', 'Contract binary arguments')
    .option('-m, --moments [moments]', 'Life moments')
    .option('-c, --contract-id [contract-id]', 'Contract id')
    .option('-i, --image [image]', 'Instance image')
    .option('-l, --life-plan [life-plan]', 'Organize cluster node lifespans using stat (static - default), rand (random), or inc (incremental) modes.')
    .option('--min-life [min-life]', 'Minimum moment count to consider in randomized node life planning.')
    .option('--max-life [max-life]', 'Maximum moment count to consider in randomized node life planning.')
    .option('--life-gap [life-gap]', 'Life gap in moments in incremental node life planning.')
    .option('--signer-count [signer-count]', 'Number of signers for a cluster with multiple signer nodes')
    .option('--signers [signers]', 'JSON file path of signer details')
    .option('--signer-life [signer-life]', 'Life moments for the signers')
    .option('--signer-quorum [signer-quorum]', 'Quorum of the cluster with multiple signer nodes (within the valid range (0,1)')
    .option('-e, --evr-limit [evr-limit]', 'Maximum amount of EVRs to be spent on instance acquisitions')
    .option('--recover [recover]', 'Recover from if there are failed cluster creations.')
    .action(clusterCreate);

program
    .command('extend')
    .description('Extend instances')
    .argument('<instances-file-path>', 'File path of instance list (in line-by-line format <host-address>:<instance-name>:<moments (optional)>)')
    .option('-m, --moments [moments]', 'Instance Life In Moments')
    .action(extend);

program
    .command('extend-instance')
    .description('Extend instance')
    .argument('<host-address>', 'Host Address')
    .argument('<instance-name>', 'Instance Name')
    .option('-m, --moments [moments]', 'Instance Life In Moments')
    .action(extendInstance);

program
    .command('audit')
    .description('Audit')
    .option('-f, --file-path [file-path]', 'File path of host account list (in line-by-line format)')
    .option('-h, --host-address [host-address]', 'Host address to be audited (for single host auditing)')
    .option('-a, --aliveness [aliveness]', 'Audit only aliveness of hosts.')
    .option('-t, --op-time [op-time]', 'Operational time threshold for the audit in hours')
    .action(audit);

program
    .option('--no-color', 'Disable colored output')

try {
    program.parse();
}
catch (e) {
    // Console outputs will be handled inside command functions.
    // Log the exception if not a console output.
    if (!('stdout' in e) && !('stderr' in e))
        console.error(e);
}
