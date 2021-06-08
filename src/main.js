require('dotenv-flow').config({
    default_node_env: 'development',
    silent: true,
});

// starting sub modules
logr = require('./logger.js');
config = require('./config.js').read(0);
http = require('./http/index.js');
p2p = require('./p2p.js');
mongo = require('./mongo.js');
chain = require('./chain.js');
transaction = require('./transaction.js');
cache = require('./cache.js');
validate = require('./validate');
eco = require('./economics.js');
rankings = require('./rankings.js');
consensus = require('./consensus');

// verify node version
var allowNodeV = [10, 12, 14, 16];
const currentNodeV = parseInt(process.versions.node.split('.')[0]);
if (allowNodeV.indexOf(currentNodeV) === -1) {
    logr.fatal(
        'Wrong NodeJS version. Allowed versions: v' + allowNodeV.join(', v')
    );
    process.exit(1);
} else logr.info('Correctly using NodeJS v' + process.versions.node);

let erroredRebuild = false;

// init the database and load most recent blocks in memory directly
mongo.init(function () {
    var timeStart = new Date().getTime();
    cache.warmup(
        'accounts',
        parseInt(process.env.WARMUP_ACCOUNTS),
        function (err) {
            if (err) throw err;
            logr.info(
                Object.keys(cache.accounts).length +
                    ' acccounts loaded in RAM in ' +
                    (new Date().getTime() - timeStart) +
                    ' ms'
            );
            timeStart = new Date().getTime();

            cache.warmup(
                'contents',
                parseInt(process.env.WARMUP_CONTENTS),
                function (err) {
                    if (err) throw err;
                    logr.info(
                        Object.keys(cache.contents).length +
                            ' contents loaded in RAM in ' +
                            (new Date().getTime() - timeStart) +
                            ' ms'
                    );
                    timeStart = new Date().getTime();

                    cache.warmupLeaders((leaderCount) => {
                        logr.info(
                            leaderCount +
                                ' leaders loaded in RAM in ' +
                                (new Date().getTime() - timeStart) +
                                ' ms'
                        );

                        // Rebuild chain state if specified. This verifies the integrity of every block and transactions and rebuild the state.
                        let rebuildResumeBlock = parseInt(
                            process.env.REBUILD_RESUME_BLK
                        );
                        let isResumingRebuild =
                            !isNaN(rebuildResumeBlock) &&
                            rebuildResumeBlock > 0;
                        if (
                            (process.env.REBUILD_STATE === '1' ||
                                process.env.REBUILD_STATE === 1) &&
                            !isResumingRebuild
                        ) {
                            logr.info(
                                'Chain state rebuild requested, unzipping blocks.zip...'
                            );
                            mongo.restoreBlocks((e) => {
                                if (e) return logr.error(e);
                                startRebuild(0);
                            });
                            return;
                        }

                        mongo.lastBlock(function (block) {
                            // Resuming an interrupted rebuild
                            if (isResumingRebuild) {
                                logr.info(
                                    'Resuming interrupted rebuild from block ' +
                                        rebuildResumeBlock
                                );
                                config = require('./config').read(
                                    rebuildResumeBlock - 1
                                );
                                chain.restoredBlocks = block._id;
                                mongo.fillInMemoryBlocks(
                                    () =>
                                        db.collection('blocks').findOne(
                                            {
                                                _id:
                                                    rebuildResumeBlock -
                                                    1 -
                                                    ((rebuildResumeBlock - 1) %
                                                        config.leaders),
                                            },
                                            (e, b) =>
                                                chain.minerSchedule(
                                                    b,
                                                    (sch) => {
                                                        chain.schedule = sch;
                                                        startRebuild(
                                                            rebuildResumeBlock
                                                        );
                                                    }
                                                )
                                        ),
                                    rebuildResumeBlock
                                );
                                return;
                            }
                            logr.info(
                                '#' +
                                    block._id +
                                    ' is the latest block in our db'
                            );
                            config = require('./config.js').read(block._id);
                            mongo.fillInMemoryBlocks(startDaemon);
                        });
                    });
                }
            );
        }
    );
});

function startRebuild(startBlock) {
    let rebuildStartTime = new Date().getTime();
    chain.lastRebuildOutput = rebuildStartTime;
    chain.rebuildState(startBlock, (e, headBlockNum) => {
        if (e) {
            erroredRebuild = true;
            return logr.error(
                'Error rebuilding chain at block',
                headBlockNum,
                e
            );
        } else if (headBlockNum <= chain.restoredBlocks)
            logr.info(
                'Rebuild interrupted, so far it took ' +
                    (new Date().getTime() - rebuildStartTime) +
                    ' ms. To resume, start Avalon with REBUILD_RESUME_BLK=' +
                    headBlockNum
            );
        else
            logr.info(
                'Rebuilt ' +
                    headBlockNum +
                    ' blocks successfully in ' +
                    (new Date().getTime() - rebuildStartTime) +
                    ' ms'
            );
        logr.info('Writing rebuild data to disk...');
        let cacheWriteStart = new Date().getTime();
        cache.writeToDisk(() => {
            logr.info(
                'Rebuild data written to disk in ' +
                    (new Date().getTime() - cacheWriteStart) +
                    ' ms'
            );
            if (chain.shuttingDown) return process.exit(0);
            startDaemon();
        }, true);
    });
}

function startDaemon() {
    // start miner schedule
    db.collection('blocks').findOne(
        {
            _id:
                chain.getLatestBlock()._id -
                (chain.getLatestBlock()._id % config.leaders),
        },
        function (err, block) {
            if (err) throw err;
            chain.minerSchedule(block, function (minerSchedule) {
                chain.schedule = minerSchedule;
            });
        }
    );

    // init hot/trending
    rankings.init();
    // start the http server
    http.init();
    // start the websocket server
    p2p.init();
    // and connect to peers
    p2p.connect(process.env.PEERS ? process.env.PEERS.split(',') : []);

    // regularly clean up old txs from mempool
    setInterval(function () {
        transaction.cleanPool();
    }, config.blockTime * 0.9);
}

process.on('SIGINT', function () {
    if (typeof closing !== 'undefined') return;
    closing = true;
    chain.shuttingDown = true;
    if (
        !erroredRebuild &&
        chain.restoredBlocks &&
        chain.getLatestBlock()._id < chain.restoredBlocks
    )
        return;
    logr.warn('Waiting ' + config.blockTime + ' ms before shut down...');
    setTimeout(function () {
        logr.info('Avalon exitted safely');
        process.exit(0);
    }, config.blockTime);
});
