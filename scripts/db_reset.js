require('dotenv-flow').config({
    default_node_env: 'development',
    silent: true,
});

const { exec } = require('child_process');

const dbURL = process.env.DB_URL;
console.log('🚀 ~ file: db_reset.js ~ line 9 ~ dbURL', dbURL);

exec(
    `mongosh "${dbURL}" < scripts/wipe_collections.js`,
    (error, stdout, stderr) => {
        if (error) {
            console.log(`error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.log(`stderr: ${stderr}`);
            return;
        }
        console.log(`done!`);
    }
);
